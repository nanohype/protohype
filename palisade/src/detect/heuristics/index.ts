import type { DetectionLayerPort } from "../../ports/index.js";
import type { LayerVerdict } from "../../types/verdict.js";
import type { NormalizedPrompt } from "../../types/prompt.js";
import { detectPatterns, type PatternConfig, type PatternHit } from "./patterns.js";

export interface HeuristicsConfig extends PatternConfig {
  /** Scores ≥ this short-circuit to MALICIOUS. */
  readonly blockThreshold: number;
  /** Scores < this short-circuit to BENIGN. */
  readonly allowThreshold: number;
}

/**
 * Heuristics layer — the fast path. Aggregates individual pattern hits into
 * a single score (max of hit scores + small bonus for multi-category hits)
 * and converts to a layer outcome via two thresholds.
 */
export function createHeuristicsLayer(config: HeuristicsConfig): DetectionLayerPort {
  return {
    name: "heuristics" as const,
    async detect(prompt: NormalizedPrompt): Promise<LayerVerdict> {
      const start = Date.now();
      const hits = detectPatterns(prompt.text, config);
      const score = aggregateScore(hits);
      const outcome: LayerVerdict["outcome"] =
        score >= config.blockThreshold ? "MALICIOUS" : score < config.allowThreshold ? "BENIGN" : "UNCERTAIN";
      return {
        layer: "heuristics",
        outcome,
        score,
        detail: {
          hitCount: hits.length,
          categories: Array.from(new Set(hits.map((h) => h.id))),
        },
        latencyMs: Date.now() - start,
      };
    },
  };
}

export function aggregateScore(hits: ReadonlyArray<PatternHit>): number {
  if (hits.length === 0) return 0;
  const max = hits.reduce((acc, h) => Math.max(acc, h.score), 0);
  const distinctCategories = new Set(hits.map((h) => h.id)).size;
  // Multi-category hits raise the floor: two distinct pattern families hitting
  // the same prompt is a stronger signal than either alone.
  const comboBonus = distinctCategories >= 2 ? 0.1 : 0;
  return Math.min(1, max + comboBonus);
}
