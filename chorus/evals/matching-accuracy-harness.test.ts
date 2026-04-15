import { describe, it, expect, vi } from 'vitest';
import {
  computeMetrics,
  thresholdSweep,
  recommendBestF1,
  findTopCandidate,
} from './matching-accuracy-harness.js';

interface PgRow {
  id: string;
  productboard_id: string;
  distance: number;
}

const item = (id: string, correct: string | null) => ({
  id,
  feedback_text: 'unused at the metric layer',
  correct_entry_id: correct,
  source: 'zendesk',
});

const candidate = (backlogEntryId: string, similarity: number) => ({
  similarity,
  distance: 1 - similarity,
  productboardId: `pb-${backlogEntryId}`,
  backlogEntryId,
});

describe('computeMetrics', () => {
  it('counts a true positive when we link to the correct backlog entry above threshold', () => {
    const scored = [{ item: item('a', 'be-1'), topCandidate: candidate('be-1', 0.9) }];
    const m = computeMetrics(scored, 0.8);
    expect(m).toMatchObject({ truePositive: 1, falsePositive: 0, falseNegative: 0, trueNegative: 0 });
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.f1).toBe(1);
  });

  it('counts a false positive when we link above threshold but to the wrong entry', () => {
    const scored = [{ item: item('a', 'be-correct'), topCandidate: candidate('be-other', 0.9) }];
    const m = computeMetrics(scored, 0.8);
    expect(m.falsePositive).toBe(1);
    expect(m.truePositive).toBe(0);
  });

  it('counts a false negative when the expected link is below the threshold', () => {
    const scored = [{ item: item('a', 'be-1'), topCandidate: candidate('be-1', 0.7) }];
    const m = computeMetrics(scored, 0.8);
    expect(m.falseNegative).toBe(1);
  });

  it('counts a true negative when the item should be NEW and we proposed below threshold', () => {
    const scored = [{ item: item('a', null), topCandidate: candidate('be-1', 0.7) }];
    const m = computeMetrics(scored, 0.8);
    expect(m.trueNegative).toBe(1);
  });

  it('counts a false positive when the item should be NEW but we crossed threshold', () => {
    const scored = [{ item: item('a', null), topCandidate: candidate('be-1', 0.85) }];
    const m = computeMetrics(scored, 0.8);
    expect(m.falsePositive).toBe(1);
  });

  it('handles a candidate of null (no neighbours in pgvector) as predicted-NEW', () => {
    const scored = [
      { item: item('a', 'be-x'), topCandidate: null }, // expected LINK, predicted NEW → FN
      { item: item('b', null), topCandidate: null }, // expected NEW, predicted NEW → TN
    ];
    const m = computeMetrics(scored, 0.8);
    expect(m.falseNegative).toBe(1);
    expect(m.trueNegative).toBe(1);
  });
});

describe('thresholdSweep', () => {
  it('produces one MetricsAtThreshold per step in the closed interval [min, max]', () => {
    const sweep = thresholdSweep([], 0.65, 0.7, 0.01);
    expect(sweep.map((m) => m.threshold)).toEqual([0.65, 0.66, 0.67, 0.68, 0.69, 0.7]);
  });

  it('rounds to the precision implied by step (no FP drift)', () => {
    const sweep = thresholdSweep([], 0.1, 0.3, 0.1);
    for (const m of sweep) {
      // Rounded to 1 decimal place — no 0.30000000000000004
      expect(m.threshold * 10).toBeCloseTo(Math.round(m.threshold * 10), 9);
    }
  });
});

describe('recommendBestF1', () => {
  it('returns the threshold with the highest F1', () => {
    const scored = [
      { item: item('1', 'be-a'), topCandidate: candidate('be-a', 0.95) }, // TP at any sane threshold
      { item: item('2', 'be-b'), topCandidate: candidate('be-b', 0.78) }, // TP iff threshold ≤ 0.78
      { item: item('3', null), topCandidate: candidate('be-x', 0.7) }, // TN iff threshold > 0.7
    ];
    const sweep = thresholdSweep(scored, 0.65, 0.9, 0.01);
    const best = recommendBestF1(sweep);
    // Best F1 is at thresholds in (0.7, 0.78] where we get 2 TP and 1 TN.
    expect(best.threshold).toBeGreaterThan(0.7);
    expect(best.threshold).toBeLessThanOrEqual(0.78);
    expect(best.f1).toBe(1);
  });

  it('throws when given an empty sweep', () => {
    expect(() => recommendBestF1([])).toThrow();
  });
});

describe('findTopCandidate', () => {
  it('runs the pgvector cosine query and returns similarity = 1 - distance', async () => {
    const queryMock = vi.fn<(sql: string, params: unknown[]) => Promise<{ rows: PgRow[] }>>(
      async () => ({
        rows: [{ id: 'be-1', productboard_id: 'pb-csv', distance: 0.12 }],
      }),
    );
    const db = { query: queryMock as unknown as DbLikeQuery };
    const r = await findTopCandidate(db, [0, 0, 0]);
    expect(r?.backlogEntryId).toBe('be-1');
    expect(r?.productboardId).toBe('pb-csv');
    expect(r?.similarity).toBeCloseTo(0.88);
    const sql = queryMock.mock.calls[0]?.[0];
    expect(sql).toContain('embedding <=> $1::vector');
    expect(sql).toContain('LIMIT 1');
  });

  it('returns null when the table has no embedded backlog entries', async () => {
    const queryMock = vi.fn(async () => ({ rows: [] as PgRow[] }));
    const db = { query: queryMock as unknown as DbLikeQuery };
    const r = await findTopCandidate(db, [0, 0, 0]);
    expect(r).toBeNull();
  });
});

type DbLikeQuery = <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }>;
