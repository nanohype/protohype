import type { Logger } from "../logger.js";
import type { CorpusIndexer, EmbeddingPort, VectorStorePort } from "./types.js";
import { chunkText, type ChunkerOptions } from "./chunker.js";

// ── Corpus indexer ─────────────────────────────────────────────────
//
// Per-rule-change pipeline: chunk the body, embed each chunk, delete
// any prior rows for this rule change, insert the new rows. The
// delete-first-then-insert shape handles the "revised rule change"
// case cleanly — a replay with an updated body replaces the old
// chunks in one step, no stale embeddings linger.
//

export interface CorpusIndexerDeps {
  readonly embedder: EmbeddingPort;
  readonly vectorStore: VectorStorePort;
  readonly chunker?: ChunkerOptions;
  readonly logger: Logger;
}

export function createCorpusIndexer(deps: CorpusIndexerDeps): CorpusIndexer {
  const { embedder, vectorStore, chunker, logger } = deps;

  return {
    async indexRuleChange(change) {
      const body = change.body || change.summary || change.title;
      const chunks = chunkText(body, chunker);
      if (chunks.length === 0) {
        logger.warn("corpus indexer: no content to index", {
          sourceId: change.sourceId,
          ruleChangeId: change.contentHash,
        });
        return { chunks: 0 };
      }
      const embeddings = await embedder.embed(chunks);
      const rows = chunks.map((content, i) => ({
        id: `${change.sourceId}:${change.contentHash}:${i}`,
        sourceId: change.sourceId,
        ruleChangeId: change.contentHash,
        chunkIndex: i,
        content,
        embedding: embeddings[i]!,
        metadata: {
          title: change.title,
          url: change.url,
          publishedAt: change.publishedAt,
        },
      }));
      await vectorStore.deleteByRuleChange(change.sourceId, change.contentHash);
      await vectorStore.upsert(rows);
      return { chunks: chunks.length };
    },
  };
}
