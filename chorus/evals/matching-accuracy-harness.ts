#!/usr/bin/env tsx
/**
 * Matching-accuracy eval harness.
 *
 * Runs the matcher against a labeled set of (feedback, expected backlog
 * entry) pairs and sweeps the cosine-similarity threshold from 0.65 →
 * 0.90 in 0.01 increments, reporting precision / recall / F1 for the
 * LINK decision at each threshold. Recommends the threshold that
 * maximises F1.
 *
 * Input: JSONL file at evals/labeled-set.jsonl. Schema in
 * evals/labeled-set-schema.md. Each line:
 *   { id, feedback_text, correct_entry_id (or null for NEW), source }
 *
 * The harness expects the backlog-entries table to be populated and
 * embedded — i.e. productboard mirror has run and embedder has
 * back-filled embeddings. It does not touch the network for embeddings;
 * it embeds each labeled item via the live Bedrock client (one call per
 * item — adjust per-second concurrency via EVAL_PARALLELISM).
 *
 * Run:
 *   DATABASE_URL=... AWS_REGION=us-east-1 npx tsx evals/matching-accuracy-harness.ts
 * Optional:
 *   EVAL_LABELED_SET_PATH=evals/labeled-set.jsonl
 *   EVAL_THRESHOLD_MIN=0.65
 *   EVAL_THRESHOLD_MAX=0.90
 *   EVAL_THRESHOLD_STEP=0.01
 *   EVAL_PARALLELISM=8
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { getDbPool, closeDbPool } from '../src/lib/db.js';
import { embedSingle } from '../src/matching/embedder.js';
import { redactPii } from '../src/matching/pii-redactor.js';
import { logger } from '../src/lib/observability.js';

interface LabeledItem {
  id: string;
  feedback_text: string;
  correct_entry_id: string | null;
  source: string;
}

interface ItemEmbedding {
  item: LabeledItem;
  embedding: number[];
}

export interface ScoredCandidate {
  /** Distance from the candidate's embedding to ours (cosine 0..2). */
  distance: number;
  /** 1 - distance, the cosine similarity in [-1, 1]. */
  similarity: number;
  productboardId: string;
  /** The matched backlog row id (UUID), used to compare to
   *  correct_entry_id. */
  backlogEntryId: string;
}

interface MetricsAtThreshold {
  threshold: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  /** TP / (TP + FP) — when we said LINK, how often was it the right link. */
  precision: number;
  /** TP / (TP + FN) — of the items that should LINK, how many did we. */
  recall: number;
  f1: number;
}

export function computeMetrics(
  scored: Array<{ item: LabeledItem; topCandidate: ScoredCandidate | null }>,
  threshold: number,
): MetricsAtThreshold {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const s of scored) {
    const expectsLink = s.item.correct_entry_id !== null;
    const wePropose =
      s.topCandidate !== null && s.topCandidate.similarity >= threshold;
    if (expectsLink && wePropose) {
      // Linked, but to the right one?
      if (s.topCandidate?.backlogEntryId === s.item.correct_entry_id) tp += 1;
      else fp += 1; // wrong target = also false-positive
    } else if (expectsLink && !wePropose) {
      fn += 1;
    } else if (!expectsLink && wePropose) {
      fp += 1;
    } else {
      tn += 1;
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    threshold,
    truePositive: tp,
    falsePositive: fp,
    trueNegative: tn,
    falseNegative: fn,
    precision,
    recall,
    f1,
  };
}

export function thresholdSweep(
  scored: Array<{ item: LabeledItem; topCandidate: ScoredCandidate | null }>,
  min: number,
  max: number,
  step: number,
): MetricsAtThreshold[] {
  const out: MetricsAtThreshold[] = [];
  // Round to avoid floating-point drift across many additions.
  const places = Math.max(0, Math.ceil(-Math.log10(step)));
  for (let t = min; t <= max + 1e-9; t += step) {
    const tRounded = Number(t.toFixed(places));
    out.push(computeMetrics(scored, tRounded));
  }
  return out;
}

export function recommendBestF1(metrics: MetricsAtThreshold[]): MetricsAtThreshold {
  if (metrics.length === 0) throw new Error('no metrics to recommend from');
  return metrics.reduce((best, m) => (m.f1 > best.f1 ? m : best));
}

export function loadLabeledSet(filePath: string): LabeledItem[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as LabeledItem;
    } catch (err) {
      throw new Error(`labeled-set line ${i + 1} is not valid JSON: ${String(err)}`);
    }
  });
}

interface DbLike {
  query<T>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
}

export async function findTopCandidate(
  db: DbLike,
  embedding: number[],
): Promise<ScoredCandidate | null> {
  const literal = `[${embedding.join(',')}]`;
  const { rows } = await db.query<{
    id: string;
    productboard_id: string;
    distance: number;
  }>(
    `SELECT id, productboard_id, (embedding <=> $1::vector) AS distance
       FROM backlog_entries
      WHERE embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT 1`,
    [literal],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    distance: r.distance,
    similarity: 1 - r.distance,
    productboardId: r.productboard_id,
    backlogEntryId: r.id,
  };
}

async function main(): Promise<void> {
  const setPath = process.env['EVAL_LABELED_SET_PATH'] ?? path.join('evals', 'labeled-set.jsonl');
  const min = Number(process.env['EVAL_THRESHOLD_MIN'] ?? '0.65');
  const max = Number(process.env['EVAL_THRESHOLD_MAX'] ?? '0.90');
  const step = Number(process.env['EVAL_THRESHOLD_STEP'] ?? '0.01');
  const parallelism = Number(process.env['EVAL_PARALLELISM'] ?? '8');

  if (!fs.existsSync(setPath)) {
    console.error(
      `labeled set not found at ${setPath}. See evals/labeled-set-schema.md for format.`,
    );
    process.exit(1);
  }

  const items = loadLabeledSet(setPath);
  logger.info('eval start', { count: items.length, parallelism, min, max, step });

  const db = getDbPool();

  // Embed every item, throttled to `parallelism` concurrent Bedrock
  // calls. Use the real redactPii so the eval reflects production.
  const embeddings: ItemEmbedding[] = [];
  const inflight: Promise<void>[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      const item = items[i]!;
      try {
        const correlationId = `eval-${item.id}`;
        const redaction = await redactPii(correlationId, item.feedback_text);
        const embedding = await embedSingle(correlationId, redaction.redactedText);
        embeddings.push({ item, embedding });
      } catch (err) {
        logger.warn('eval item failed; skipping', { id: item.id, error: String(err) });
      }
    }
  }

  for (let i = 0; i < parallelism; i++) inflight.push(worker());
  await Promise.all(inflight);

  const scored: Array<{ item: LabeledItem; topCandidate: ScoredCandidate | null }> = [];
  for (const { item, embedding } of embeddings) {
    const top = await findTopCandidate(db, embedding);
    scored.push({ item, topCandidate: top });
  }

  const sweep = thresholdSweep(scored, min, max, step);
  const best = recommendBestF1(sweep);

  console.log('threshold,precision,recall,f1,tp,fp,tn,fn');
  for (const m of sweep) {
    console.log(
      [
        m.threshold,
        m.precision.toFixed(4),
        m.recall.toFixed(4),
        m.f1.toFixed(4),
        m.truePositive,
        m.falsePositive,
        m.trueNegative,
        m.falseNegative,
      ].join(','),
    );
  }

  console.log('');
  console.log(
    `Recommended MATCH_THRESHOLD=${best.threshold} (F1=${best.f1.toFixed(4)}, P=${best.precision.toFixed(4)}, R=${best.recall.toFixed(4)})`,
  );

  await closeDbPool();
}

// CLI entrypoint
const isCli = import.meta.url === `file://${process.argv[1] ?? ''}`;
if (isCli) {
  main().catch((err: unknown) => {
    logger.error('eval fatal', { error: String(err) });
    process.exit(1);
  });
}

// Bedrock client export so callers can mock it in tests.
export { BedrockRuntimeClient };
