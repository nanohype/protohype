#!/usr/bin/env tsx
/**
 * Canonical eval runner. Feeds every attack + benign prompt through the
 * full detection pipeline (with fakes wired) and emits per-layer and end-
 * to-end metrics:
 *   - Per-layer TPR (attacks caught by layer N)
 *   - End-to-end TPR (attacks blocked by the full pipeline)
 *   - End-to-end FPR (benign prompts blocked)
 *
 * Output goes to `eval/results.json` and stdout. `scripts/eval/compare.ts`
 * diffs against `eval/baseline.json` and fails CI on regression.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { createHeuristicsLayer } from "../../src/detect/heuristics/index.js";
import { createClassifierLayer } from "../../src/detect/classifier/index.js";
import { createFakeClassifier } from "../../src/detect/classifier/fake.js";
import { createCorpusMatchLayer } from "../../src/detect/corpus-match/index.js";
import { createFakeEmbedder } from "../../src/detect/corpus-match/fake-embedder.js";
import { createMemoryCorpus } from "../../src/corpus/memory-corpus.js";
import { createDetectionPipeline } from "../../src/detect/pipeline.js";
import { createLogger } from "../../src/logger.js";
import { normalize } from "../../src/proxy/normalize.js";
import type { NormalizedPrompt } from "../../src/types/prompt.js";

interface EvalItem {
  readonly id: string;
  readonly taxonomy?: string;
  readonly prompt: string;
}

interface Suite {
  readonly suite: string;
  readonly version: number;
  readonly items: ReadonlyArray<EvalItem>;
}

interface Result {
  readonly id: string;
  readonly expected: "MALICIOUS" | "BENIGN";
  readonly actual: "MALICIOUS" | "BENIGN";
  readonly blockingLayer?: string;
  readonly layerOutcomes: Record<string, string>;
}

async function main(): Promise<void> {
  const attacks = parse(readFileSync("eval/attacks.yaml", "utf8")) as Suite;
  const benign = parse(readFileSync("eval/benign.yaml", "utf8")) as Suite;

  const logger = createLogger("error");
  const metrics = { counter: () => undefined, histogram: () => undefined };
  const tracer = {
    withSpan: async <T>(
      _n: string,
      _a: Record<string, unknown>,
      fn: (span: { setAttribute: (k: string, v: unknown) => void }) => Promise<T>,
    ): Promise<T> => fn({ setAttribute: () => undefined }),
  };

  const heuristics = createHeuristicsLayer({ base64MinBytes: 256, blockThreshold: 0.9, allowThreshold: 0.3 });
  const classifierLayer = createClassifierLayer(createFakeClassifier(), { blockThreshold: 0.85, allowThreshold: 0.25 });
  const corpus = createMemoryCorpus();
  const embedder = createFakeEmbedder(256);
  const corpusLayer = createCorpusMatchLayer(embedder, corpus.read, { threshold: 0.995, topK: 5 });
  const pipeline = createDetectionPipeline({
    heuristics,
    classifier: classifierLayer,
    corpusMatch: corpusLayer,
    timeouts: { heuristicsMs: 200, classifierMs: 2_000, corpusMatchMs: 1_500 },
    metrics,
    tracer,
    logger,
  });

  const results: Result[] = [];

  for (const it of attacks.items) {
    const prompt = toPrompt(it.prompt);
    const verdict = await pipeline.run(prompt);
    results.push({
      id: it.id,
      expected: "MALICIOUS",
      actual: verdict.finalOutcome,
      ...(verdict.blockingLayer ? { blockingLayer: verdict.blockingLayer } : {}),
      layerOutcomes: Object.fromEntries(verdict.layers.map((l) => [l.layer, l.outcome])),
    });
  }
  for (const it of benign.items) {
    const prompt = toPrompt(it.prompt);
    const verdict = await pipeline.run(prompt);
    results.push({
      id: it.id,
      expected: "BENIGN",
      actual: verdict.finalOutcome,
      ...(verdict.blockingLayer ? { blockingLayer: verdict.blockingLayer } : {}),
      layerOutcomes: Object.fromEntries(verdict.layers.map((l) => [l.layer, l.outcome])),
    });
  }

  const summary = summarize(results);
  writeFileSync("eval/results.json", JSON.stringify({ summary, results }, null, 2));

  console.log(`palisade-eval results:
  attacks:           ${summary.attacks.total}
  attacks blocked:   ${summary.attacks.blocked} (TPR = ${summary.tpr.toFixed(3)})
  benign:            ${summary.benign.total}
  benign blocked:    ${summary.benign.blocked} (FPR = ${summary.fpr.toFixed(3)})
  per-layer TPR:     heuristics=${summary.perLayerTpr.heuristics.toFixed(3)}  classifier=${summary.perLayerTpr.classifier.toFixed(3)}  corpus=${summary.perLayerTpr["corpus-match"].toFixed(3)}
`);
}

function toPrompt(text: string): NormalizedPrompt {
  const rawBody = new TextEncoder().encode(JSON.stringify({ messages: [{ role: "user", content: text }] }));
  return normalize({
    upstream: "openai-chat",
    rawBody,
    headers: {},
    identity: { ip: "127.0.0.1" },
    traceId: "eval",
  });
}

interface Summary {
  readonly tpr: number;
  readonly fpr: number;
  readonly attacks: { total: number; blocked: number };
  readonly benign: { total: number; blocked: number };
  readonly perLayerTpr: Record<"heuristics" | "classifier" | "corpus-match", number>;
}

function summarize(results: ReadonlyArray<Result>): Summary {
  const attacks = results.filter((r) => r.expected === "MALICIOUS");
  const benign = results.filter((r) => r.expected === "BENIGN");
  const attacksBlocked = attacks.filter((r) => r.actual === "MALICIOUS").length;
  const benignBlocked = benign.filter((r) => r.actual === "MALICIOUS").length;
  const tpr = attacks.length === 0 ? 1 : attacksBlocked / attacks.length;
  const fpr = benign.length === 0 ? 0 : benignBlocked / benign.length;
  const perLayerTpr = {
    heuristics: attacks.filter((r) => r.blockingLayer === "heuristics").length / Math.max(1, attacks.length),
    classifier: attacks.filter((r) => r.blockingLayer === "classifier").length / Math.max(1, attacks.length),
    "corpus-match": attacks.filter((r) => r.blockingLayer === "corpus-match").length / Math.max(1, attacks.length),
  };
  return {
    tpr,
    fpr,
    attacks: { total: attacks.length, blocked: attacksBlocked },
    benign: { total: benign.length, blocked: benignBlocked },
    perLayerTpr,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
