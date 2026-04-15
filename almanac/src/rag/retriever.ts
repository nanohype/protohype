/**
 * Hybrid retriever: k-NN + lexical (BM25-style) with Reciprocal Rank
 * Fusion. Both search methods are delegated to a `RetrievalBackend`
 * port (null, pgvector, or a client-supplied implementation) — this
 * module owns the query-embedding call against Bedrock Titan and the
 * fusion logic; the backend owns the wire format.
 *
 * The pure `rrfFusion` is exported for direct coverage.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { RetrievalHit } from "../connectors/types.js";
import type { RetrievalBackend } from "./backends/types.js";
import { logger } from "../logger.js";

const TOP_K = 20;
const FINAL_K = 10;
const EMBED_TIMEOUT_MS = 5000;

export interface RetrieverConfig {
  backend: RetrievalBackend;
  bedrock: BedrockRuntimeClient;
  embeddingModelId: string;
  onTiming?: (metric: string, ms: number) => void;
}

export interface Retriever {
  embedQuery(queryText: string): Promise<number[]>;
  hybridSearch(queryText: string, queryEmbedding: number[]): Promise<RetrievalHit[]>;
}

export function createRetriever(deps: RetrieverConfig): Retriever {
  const timing = deps.onTiming ?? (() => {});

  return {
    async embedQuery(queryText) {
      const start = Date.now();
      const response = await deps.bedrock.send(
        new InvokeModelCommand({
          modelId: deps.embeddingModelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({ inputText: queryText }),
        }),
        { abortSignal: AbortSignal.timeout(EMBED_TIMEOUT_MS) },
      );
      timing("EmbeddingLatency", Date.now() - start);
      const payload = JSON.parse(new TextDecoder().decode(response.body));
      return payload.embedding as number[];
    },

    async hybridSearch(queryText, queryEmbedding) {
      const start = Date.now();
      const [knnHits, textHits] = await Promise.all([
        deps.backend.knnSearch({ embedding: queryEmbedding, topK: TOP_K }),
        deps.backend.textSearch({ query: queryText, topK: TOP_K }),
      ]);
      timing("RetrievalLatency", Date.now() - start);
      const knnRanked = knnHits.map((hit, index) => ({ hit, rank: index + 1 }));
      const textRanked = textHits.map((hit, index) => ({ hit, rank: index + 1 }));
      const fused = rrfFusion(knnRanked, textRanked, FINAL_K);
      logger.debug(
        { knnCount: knnHits.length, textCount: textHits.length, fusedCount: fused.length },
        "hybrid search",
      );
      return fused;
    },
  };
}

export function rrfFusion(
  knnRanked: Array<{ hit: RetrievalHit; rank: number }>,
  textRanked: Array<{ hit: RetrievalHit; rank: number }>,
  topK: number,
): RetrievalHit[] {
  const RRF_K = 60;
  const scores = new Map<string, { hit: RetrievalHit; score: number }>();
  for (const { hit, rank } of knnRanked) {
    const rrfScore = 1 / (RRF_K + rank);
    const existing = scores.get(hit.docId);
    if (existing) existing.score += rrfScore;
    else scores.set(hit.docId, { hit, score: rrfScore });
  }
  for (const { hit, rank } of textRanked) {
    const rrfScore = 1 / (RRF_K + rank);
    const existing = scores.get(hit.docId);
    if (existing) existing.score += rrfScore;
    else scores.set(hit.docId, { hit, score: rrfScore });
  }
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ hit, score }) => ({ ...hit, score }));
}
