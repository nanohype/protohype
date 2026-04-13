/**
 * Almanac RAG Pipeline — main orchestrator
 *
 * Flow:
 *   1. PII guard (reject if detected)
 *   2. Query rewrite
 *   3. Multi-source ACL-aware retrieval (fan-out, per-user OAuth)
 *   4. Score + rank candidates
 *   5. Generate answer (Claude 3 Haiku via Bedrock, no-log inference profile)
 *   6. Format citations + stale warnings
 *   7. Return AlmanacAnswer
 */
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { AnswerGenerator } from './generator.js';
import { buildCitations, computeStaleWarnings, formatForSlack } from './formatter.js';
import { PiiGuard } from './pii-guard.js';
import { MultiSourceRetriever } from './retriever.js';
import type { AlmanacAnswer, ConnectorAdapter, ConnectorName, OAuthToken } from './types.js';

export interface PipelineConfig {
  region: string;
  topChunksForGeneration?: number;
}

export interface PipelineInput {
  question: string;
  slackUserId: string;
  userTokens: Partial<Record<ConnectorName, OAuthToken>>;
}

export interface PipelineOutput {
  answer: AlmanacAnswer;
  slackBlocks: object;
}

export class AlmanacPipeline {
  private piiGuard: PiiGuard;
  private retriever: MultiSourceRetriever;
  private generator: AnswerGenerator;
  private topChunksForGeneration: number;

  constructor(config: PipelineConfig, connectorAdapters: ConnectorAdapter[]) {
    const bedrockClient = new BedrockRuntimeClient({ region: config.region });
    this.piiGuard = new PiiGuard(bedrockClient);
    this.retriever = new MultiSourceRetriever(bedrockClient, connectorAdapters);
    this.generator = new AnswerGenerator(bedrockClient);
    this.topChunksForGeneration = config.topChunksForGeneration ?? 5;
  }

  async run(input: PipelineInput): Promise<PipelineOutput> {
    const startMs = Date.now();

    const piiResult = await this.piiGuard.check(input.question);
    if (piiResult.containsPii) {
      const answer: AlmanacAnswer = {
        text: "I'm not able to process queries containing personal information.",
        citations: [],
        staleWarnings: [],
        connectorStatuses: { notion: 'ok', confluence: 'ok', gdrive: 'ok' },
        latencyMs: Date.now() - startMs,
      };
      return { answer, slackBlocks: formatForSlack(answer) };
    }

    const rewrittenQuery = await this.generator.rewriteQuery(input.question);
    const { chunks, connectorStatuses } = await this.retriever.retrieve(rewrittenQuery, input.userTokens);
    const topChunks = chunks.slice(0, this.topChunksForGeneration);
    const answerText = await this.generator.generateAnswer(rewrittenQuery, topChunks);
    const citations = buildCitations(topChunks);
    const staleWarnings = computeStaleWarnings(citations);

    const answer: AlmanacAnswer = {
      text: answerText,
      citations,
      staleWarnings,
      connectorStatuses,
      latencyMs: Date.now() - startMs,
    };

    return { answer, slackBlocks: formatForSlack(answer) };
  }
}
