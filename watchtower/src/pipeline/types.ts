import type { RuleChange } from "../crawlers/types.js";

// ── Pipeline contracts ─────────────────────────────────────────────
//
// The corpus pipeline takes a RuleChange and:
//   1. chunks the body into overlapping segments
//   2. embeds each chunk via Bedrock Titan
//   3. upserts (ruleChangeId, chunkIndex) rows into pgvector
//
// The vector store is the long-term corpus — classifier v1 doesn't
// query it on the hot path, but future retrieval (find related past
// rule changes when drafting a memo) does. Keep the indexer side-
// effecting and idempotent per (sourceId, contentHash, chunkIndex).
//

export interface Chunk {
  readonly index: number;
  readonly content: string;
}

export interface EmbeddingPort {
  readonly dimensions: number;
  readonly modelId: string;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

export interface VectorRow {
  readonly id: string; // `${sourceId}:${contentHash}:${chunkIndex}`
  readonly sourceId: string;
  readonly ruleChangeId: string; // contentHash
  readonly chunkIndex: number;
  readonly content: string;
  readonly embedding: readonly number[];
  readonly metadata: {
    readonly title: string;
    readonly url: string;
    readonly publishedAt: string;
  };
}

export interface VectorStorePort {
  /** Upsert a batch of rows keyed by `id`. Idempotent. */
  upsert(rows: readonly VectorRow[]): Promise<void>;

  /**
   * Delete every row whose `ruleChangeId` matches. Used when a
   * re-crawl detects a revised rule change — we drop the old chunks
   * before writing the new ones so cosine queries don't hit both.
   */
  deleteByRuleChange(sourceId: string, ruleChangeId: string): Promise<void>;

  /** Record count for a given ruleChangeId — used by tests and diagnostics. */
  countByRuleChange(sourceId: string, ruleChangeId: string): Promise<number>;
}

export interface CorpusIndexer {
  /** Chunk, embed, and upsert a single rule change. */
  indexRuleChange(change: RuleChange): Promise<{ chunks: number }>;
}
