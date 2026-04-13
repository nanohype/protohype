/**
 * Cross-encoder reranker using Cohere Rerank API (primary) or
 * score normalization fallback (no external call).
 */
import axios from 'axios';
import { config } from '../config';
import { logger } from '../middleware/logger';
import type { RetrievalChunk, RankedChunk } from '../types';

const STALE_THRESHOLD_MS = config.STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

export async function rerank(
  query: string,
  chunks: RetrievalChunk[],
  topK: number
): Promise<RankedChunk[]> {
  if (chunks.length === 0) return [];

  let unifiedScores: number[];

  if (config.COHERE_API_KEY) {
    try {
      unifiedScores = await cohereRerank(query, chunks);
    } catch (err) {
      logger.warn({ err }, 'Cohere rerank failed, falling back to raw scores');
      unifiedScores = normalizeScores(chunks.map((c) => c.rawScore));
    }
  } else {
    unifiedScores = normalizeScores(chunks.map((c) => c.rawScore));
  }

  const now = Date.now();

  const ranked = chunks
    .map((chunk, i) => ({
      ...chunk,
      unifiedScore: unifiedScores[i] ?? chunk.rawScore,
      isStale: chunk.lastModifiedAt
        ? now - chunk.lastModifiedAt.getTime() > STALE_THRESHOLD_MS
        : false,
      freshnessUnknown: chunk.lastModifiedAt === null,
    }))
    .sort((a, b) => b.unifiedScore - a.unifiedScore)
    .slice(0, topK);

  return ranked;
}

async function cohereRerank(query: string, chunks: RetrievalChunk[]): Promise<number[]> {
  const response = await axios.post(
    'https://api.cohere.ai/v1/rerank',
    {
      model: 'rerank-english-v3.0',
      query,
      documents: chunks.map((c) => c.chunkText.slice(0, 512)),
      top_n: chunks.length,
    },
    {
      headers: {
        Authorization: `Bearer ${config.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 3000,
    }
  );

  const results = response.data.results as Array<{ index: number; relevance_score: number }>;
  const scores = new Array(chunks.length).fill(0);
  for (const result of results) {
    scores[result.index] = result.relevance_score;
  }
  return scores;
}

function normalizeScores(rawScores: number[]): number[] {
  const max = Math.max(...rawScores, 1);
  return rawScores.map((s) => s / max);
}
