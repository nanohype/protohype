import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findMatch, type MatcherDeps } from './matcher.js';
import { asRedactedForTests } from './redacted-text.js';
import type { Pool } from 'pg';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { AuditPort, AuditLogEntry } from '../lib/audit.js';

interface Candidate {
  id: string;
  linear_id: string;
  title: string;
  distance: number;
}

function recordingAudit(): { audit: AuditPort; calls: AuditLogEntry[] } {
  const calls: AuditLogEntry[] = [];
  return { audit: async (entry) => void calls.push(entry), calls };
}

function makeDeps(
  rows: Candidate[],
  draftTitle = 'Adding exportable reports',
): MatcherDeps & { auditCalls: AuditLogEntry[]; queryMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi.fn(async () => ({ rows }));
  const db = { query: queryMock } as unknown as Pool;
  const bedrockClient = {} as BedrockRuntimeClient;
  const generateDraftTitle = vi.fn(async () => draftTitle);
  const { audit, calls } = recordingAudit();
  return { db, bedrockClient, generateDraftTitle, audit, auditCalls: calls, queryMock };
}

const embedding: number[] = new Array<number>(1024).fill(0);
const text = asRedactedForTests('[EMAIL] wants CSV exports');

describe('findMatch', () => {
  beforeEach(() => {
    delete process.env['MATCH_THRESHOLD'];
  });

  it('returns LINK when the top candidate exceeds the match threshold AND audits MATCH with the score', async () => {
    const deps = makeDeps([
      { id: 'pb-1', linear_id: 'lin:1', title: 'CSV exports', distance: 0.1 },
      { id: 'pb-2', linear_id: 'lin:2', title: 'Data exports', distance: 0.3 },
    ]);
    const p = await findMatch('corr-1', 'feedback-1', embedding, text, deps);
    expect(p.type).toBe('LINK');
    expect(p.backlogEntryId).toBe('pb-1');
    expect(p.similarityScore).toBeCloseTo(0.9);
    expect(deps.generateDraftTitle).not.toHaveBeenCalled();
    expect(deps.auditCalls).toHaveLength(1);
    expect(deps.auditCalls[0]).toMatchObject({
      correlationId: 'corr-1',
      stage: 'MATCH',
      feedbackItemId: 'feedback-1',
      backlogEntryId: 'pb-1',
    });
    expect((deps.auditCalls[0]?.detail as Record<string, unknown>)['proposalType']).toBe('LINK');
  });

  it('falls through to LINK via the duplicate-threshold guard when MATCH is set high', async () => {
    process.env['MATCH_THRESHOLD'] = '0.95';
    vi.resetModules();
    const matcherMod = await import('./matcher.js');
    const deps = makeDeps([
      { id: 'pb-dup', linear_id: 'lin:dup', title: 'CSV exports', distance: 0.12 },
    ]);
    const p = await matcherMod.findMatch('corr-2', 'feedback-2', embedding, text, deps);
    expect(p.type).toBe('LINK');
    expect(p.backlogEntryId).toBe('pb-dup');
    expect(deps.generateDraftTitle).not.toHaveBeenCalled();
  });

  it('returns NEW with a draft title when no candidate clears either threshold', async () => {
    const deps = makeDeps(
      [{ id: 'pb-3', linear_id: 'lin:3', title: 'Unrelated', distance: 0.5 }],
      'Supporting CSV exports',
    );
    const p = await findMatch('corr-3', 'feedback-3', embedding, text, deps);
    expect(p.type).toBe('NEW');
    expect(p.backlogEntryId).toBeUndefined();
    expect(p.draftTitle).toBe('Supporting CSV exports');
    expect(deps.generateDraftTitle).toHaveBeenCalledOnce();
    expect((deps.auditCalls[0]?.detail as Record<string, unknown>)['proposalType']).toBe('NEW');
  });

  it('returns NEW when the candidate list is empty', async () => {
    const deps = makeDeps([], 'Cold-start request');
    const p = await findMatch('corr-4', 'feedback-4', embedding, text, deps);
    expect(p.type).toBe('NEW');
    expect(p.topCandidates).toHaveLength(0);
    expect(p.draftTitle).toBe('Cold-start request');
  });

  it('parameterises the pgvector cosine query with the embedding and a LIMIT of 5', async () => {
    const deps = makeDeps([]);
    await findMatch('corr-5', 'feedback-5', embedding, text, deps);
    const call = deps.queryMock.mock.calls[0] as [string, unknown[]];
    expect(call[0]).toContain('embedding <=> $1::vector');
    expect(call[0]).toContain('LIMIT $2');
    expect(call[1][1]).toBe(5);
  });
});
