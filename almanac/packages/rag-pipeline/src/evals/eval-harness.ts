/**
 * Eval harness for Almanac RAG pipeline.
 * ACL leak rate must be exactly 0% -- any leak blocks deployment.
 */

import { AclRetriever } from "../retriever/acl-retriever";
import { AnswerGenerator } from "../generator/answer-generator";

export interface EvalCase {
  id: string;
  query: string;
  oktaUserId: string;
  goldDocIds: string[];
  expectNoAccess?: boolean; // user should receive zero chunks
  expectFallback?: boolean;
}

export interface EvalResult {
  caseId: string;
  pass: boolean;
  retrievalRecallAt5: number;
  aclLeak: boolean;
  latencyMs: number;
  staleWarningShown?: boolean;
  error?: string;
}

export class EvalHarness {
  constructor(
    private readonly retriever: AclRetriever,
    private readonly generator: AnswerGenerator
  ) {}

  async runCase(evalCase: EvalCase): Promise<EvalResult> {
    const start = Date.now();
    try {
      const { chunks } = await this.retriever.retrieve(evalCase.query, evalCase.oktaUserId);

      const aclLeak = evalCase.expectNoAccess === true && chunks.length > 0;
      if (aclLeak) {
        console.error(`[EVAL] ACL LEAK: case ${evalCase.id} -- user ${evalCase.oktaUserId} got ${chunks.length} unauthorized chunks`);
      }

      const retrievedDocIds = new Set(chunks.slice(0, 5).map((c) => c.docId));
      const recallAt5 = evalCase.goldDocIds.length === 0
        ? 1.0
        : evalCase.goldDocIds.filter((id) => retrievedDocIds.has(id)).length / evalCase.goldDocIds.length;

      const staleWarningShown = chunks.some(
        (c) => c.lastModified && (Date.now() - new Date(c.lastModified).getTime()) / 86400000 > 90
      );

      const latencyMs = Date.now() - start;
      return { caseId: evalCase.id, pass: !aclLeak && recallAt5 >= 0.8 && latencyMs < 3000, retrievalRecallAt5: recallAt5, aclLeak, latencyMs, staleWarningShown };
    } catch (err) {
      return { caseId: evalCase.id, pass: false, retrievalRecallAt5: 0, aclLeak: false, latencyMs: Date.now() - start, error: String(err) };
    }
  }

  async runSuite(cases: EvalCase[]): Promise<{ results: EvalResult[]; summary: string }> {
    const results = await Promise.all(cases.map((c) => this.runCase(c)));
    const total = results.length;
    const passed = results.filter((r) => r.pass).length;
    const aclLeaks = results.filter((r) => r.aclLeak).length;
    const avgRecall = results.reduce((s, r) => s + r.retrievalRecallAt5, 0) / total;
    const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / total;
    const summary = [
      `Eval Suite (${total} cases)`,
      `Pass rate: ${((passed / total) * 100).toFixed(1)}%`,
      `ACL leaks: ${aclLeaks} (MUST BE 0 -- blocks deployment if >0)`,
      `Recall@5: ${(avgRecall * 100).toFixed(1)}%`,
      `Avg latency: ${avgLatency.toFixed(0)}ms`,
    ].join("\n");
    if (aclLeaks > 0) console.error("[EVAL CRITICAL] ACL leaks detected -- BLOCK DEPLOYMENT");
    return { results, summary };
  }
}
