import { describe, it, expect, vi } from 'vitest';
import { processFeedbackItem, type PipelineDeps } from './pipeline.js';
import { asRedactedForTests } from '../matching/redacted-text.js';
import type { RawFeedbackItem } from './types.js';
import type { DlqMessage } from '../lib/queue.js';
import type { AuditPort, AuditLogEntry } from '../lib/audit.js';
import type { Pool } from 'pg';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

const item: RawFeedbackItem = {
  source: 'slack',
  sourceItemId: 'C-feedback:1711992000.000001',
  sourceUrl: 'https://acme.slack.com/archives/C-feedback/p1711992000000001',
  verbatimText: 'Need CSV exports — bigcorp@acme.com',
  customerRef: 'bigcorp@acme.com',
  aclSquadIds: ['growth'],
};

function recordingAudit(): { audit: AuditPort; calls: AuditLogEntry[] } {
  const calls: AuditLogEntry[] = [];
  return { audit: async (entry) => void calls.push(entry), calls };
}

function makeDb(insertedId = 'feedback-id-1'): Pool {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: insertedId }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 }),
  } as unknown as Pool;
}

function makeDeps(
  db: Pool,
  overrides: Partial<PipelineDeps> = {},
): PipelineDeps & { auditCalls: AuditLogEntry[] } {
  const { audit, calls } = recordingAudit();
  const redact = vi.fn(async (_id: string, text: string) => ({
    redactedText: asRedactedForTests(text.replace(/\S+@\S+/, '[EMAIL]')),
    piiDetected: true,
    entitiesFound: ['EMAIL'],
  }));
  const embed = vi.fn(async () => new Array<number>(1024).fill(0.1));
  const match = vi.fn(async () => ({
    type: 'LINK' as const,
    backlogEntryId: 'pb-csv-exports',
    similarityScore: 0.91,
    topCandidates: [
      {
        id: 'pb-csv-exports',
        linearId: 'lin:csv',
        title: 'CSV exports',
        similarityScore: 0.91,
      },
    ],
  }));
  return {
    db,
    matcherDeps: {
      db,
      bedrockClient: {} as BedrockRuntimeClient,
      generateDraftTitle: vi.fn(async () => 'Adding CSV exports'),
      audit,
    },
    dlq: { sendMessage: vi.fn(async () => undefined) },
    audit,
    redact,
    embed,
    match,
    auditCalls: calls,
    ...overrides,
  };
}

describe('processFeedbackItem', () => {
  it('runs INGEST → REDACT → EMBED → persist → MATCH → PROPOSE in order, returns proposal, audits at INGEST and PROPOSE', async () => {
    const db = makeDb();
    const deps = makeDeps(db);
    const r = await processFeedbackItem(item, deps);

    expect(r.feedbackItemId).toBe('feedback-id-1');
    expect(r.proposal.type).toBe('LINK');
    expect(r.proposal.backlogEntryId).toBe('pb-csv-exports');
    expect(r.correlationId).toMatch(/^[0-9a-f-]{36}$/i);

    const queryMock = db.query as unknown as ReturnType<typeof vi.fn>;
    expect(queryMock).toHaveBeenCalledTimes(3);

    const stages = deps.auditCalls.map((c) => c.stage);
    expect(stages).toContain('INGEST');
    expect(stages).toContain('PROPOSE');
    const propose = deps.auditCalls.find((c) => c.stage === 'PROPOSE');
    expect(propose?.feedbackItemId).toBe('feedback-id-1');
    expect(propose?.backlogEntryId).toBe('pb-csv-exports');
  });

  it('passes the redacted text — never the verbatim — to the embedder', async () => {
    const db = makeDb();
    const deps = makeDeps(db);
    await processFeedbackItem(item, deps);
    const embedMock = deps.embed as ReturnType<typeof vi.fn>;
    const passedText = embedMock.mock.calls[0]?.[1] as string;
    expect(passedText).not.toContain('@acme.com');
    expect(passedText).toContain('[EMAIL]');
  });

  it('persists the connector-supplied ACL on the raw_evidence row', async () => {
    const db = makeDb();
    const deps = makeDeps(db);
    await processFeedbackItem(item, deps);
    const evidenceCall = (db.query as unknown as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(evidenceCall[0]).toContain('raw_evidence');
    expect(evidenceCall[1][3]).toEqual(['growth']);
    expect(evidenceCall[1][4]).toEqual([]);
  });

  it('routes to the DLQ with stage=PIPELINE and rethrows on any pipeline failure', async () => {
    const db = makeDb();
    const failingEmbed = vi.fn(async () => {
      throw new Error('Bedrock 503');
    });
    const dlqSend = vi.fn<(m: DlqMessage) => Promise<void>>(async () => undefined);
    const dlq = { sendMessage: dlqSend };
    const deps = makeDeps(db, { embed: failingEmbed, dlq });

    await expect(processFeedbackItem(item, deps)).rejects.toThrow('Bedrock 503');

    expect(dlqSend).toHaveBeenCalledOnce();
    const msg = dlqSend.mock.calls[0]?.[0];
    expect(msg).toBeDefined();
    expect(msg?.source).toBe('slack');
    expect(msg?.sourceItemId).toBe('C-feedback:1711992000.000001');
    expect(msg?.stage).toBe('PIPELINE');
    expect(msg?.error).toContain('Bedrock 503');
  });

  it('handles the NEW path: backlogEntryId undefined, persistProposal sets the column to NULL, draftTitle preserved', async () => {
    const db = makeDb();
    const newMatch = vi.fn(async () => ({
      type: 'NEW' as const,
      topCandidates: [],
      draftTitle: 'Adding CSV exports',
    }));
    const deps = makeDeps(db, { match: newMatch });
    const r = await processFeedbackItem(item, deps);

    expect(r.proposal.type).toBe('NEW');
    expect(r.proposal.backlogEntryId).toBeUndefined();
    expect(r.proposal.draftTitle).toBe('Adding CSV exports');

    const updateCall = (db.query as unknown as ReturnType<typeof vi.fn>).mock.calls[2] as [
      string,
      unknown[],
    ];
    expect(updateCall[0]).toContain('UPDATE feedback_items');
    expect(updateCall[1][1]).toBeNull();
  });
});
