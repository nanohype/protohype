/**
 * Integration test: an item flows through the full real pipeline —
 * pii-redactor → embedder → matcher (real findMatch SQL) → audit
 * (recording port) — with only the AWS SDKs and Postgres stubbed at
 * the boundary. No `vi.mock` of internal modules. This proves the
 * real wiring composes; previous unit tests prove each link in
 * isolation.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import type { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { processFeedbackItem } from './pipeline.js';
import { createPiiRedactor, type ComprehendPort } from '../matching/pii-redactor.js';
import { createEmbedder, type BedrockPort } from '../matching/embedder.js';
import { createTitleGenerator } from '../matching/title-generator.js';
import { findMatch } from '../matching/matcher.js';
import type { AuditPort, AuditLogEntry } from '../lib/audit.js';
import type { DlqMessage } from '../lib/queue.js';
import type { RawFeedbackItem } from './types.js';

function recordingAudit(): { audit: AuditPort; calls: AuditLogEntry[] } {
  const calls: AuditLogEntry[] = [];
  return { audit: async (entry) => void calls.push(entry), calls };
}

const item: RawFeedbackItem = {
  source: 'slack',
  sourceItemId: 'C-feedback:1711992000.000001',
  sourceUrl: 'https://acme.slack.com/archives/C-feedback/p1711992000000001',
  verbatimText: 'Please add CSV exports — bigcorp@acme.com is asking',
  customerRef: 'bigcorp@acme.com',
  aclSquadIds: ['growth'],
};

describe('pipeline integration (real pipeline + matcher + redactor + embedder + title)', () => {
  it('LINK path: persists the redacted text + ACL, returns LINK proposal pointing at top backlog row', async () => {
    // Comprehend port returns no entities (regex strips the email; that's enough for this test)
    const comprehend: ComprehendPort = {
      send: vi.fn(async (_cmd: DetectPiiEntitiesCommand) => ({ Entities: [] })),
    };
    // Bedrock returns a deterministic embedding
    const bedrock: BedrockPort = {
      send: vi.fn(async (_cmd: InvokeModelCommand) => ({
        body: new TextEncoder().encode(
          JSON.stringify({ embedding: new Array<number>(1024).fill(0.1) }),
        ),
      })),
    };
    const { audit, calls } = recordingAudit();

    const redact = createPiiRedactor({ comprehend, audit });
    const embedder = createEmbedder({ bedrock, audit });
    const generateDraftTitle = createTitleGenerator({ bedrock });

    // DB stub: matcher.findMatch SELECT then pipeline INSERT, INSERT, UPDATE
    const matcherSelect = {
      rows: [{ id: 'be-csv', linear_id: 'lin-csv', title: 'CSV exports', distance: 0.05 }],
    };
    const dbQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'fi-1' }] }) // INSERT INTO feedback_items
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT INTO raw_evidence
      .mockResolvedValueOnce(matcherSelect) // findMatch SELECT
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE feedback_items (persistProposal)
    const db = { query: dbQuery } as unknown as Pool;

    const dlqSend = vi.fn<(m: DlqMessage) => Promise<void>>(async () => undefined);

    const result = await processFeedbackItem(item, {
      db,
      audit,
      matcherDeps: {
        db,
        bedrockClient: {} as never,
        generateDraftTitle,
        audit,
      },
      dlq: { sendMessage: dlqSend },
      redact,
      embed: (id, text) => embedder.embedSingle(id, text),
      match: findMatch,
    });

    expect(result.feedbackItemId).toBe('fi-1');
    expect(result.proposal.type).toBe('LINK');
    expect(result.proposal.backlogEntryId).toBe('be-csv');
    expect(result.proposal.similarityScore).toBeCloseTo(0.95);

    // The redacted text persisted to feedback_items must NOT contain the email
    const insertCall = dbQuery.mock.calls[0] as [string, unknown[]];
    expect(insertCall[0]).toContain('INSERT INTO feedback_items');
    expect(String(insertCall[1][4])).toContain('[EMAIL]');
    expect(String(insertCall[1][4])).not.toContain('bigcorp@acme.com');

    // ACL persisted on raw_evidence
    const evidenceCall = dbQuery.mock.calls[1] as [string, unknown[]];
    expect(evidenceCall[0]).toContain('raw_evidence');
    expect(evidenceCall[1][3]).toEqual(['growth']);

    // Audit fired at least once for each of REDACT / EMBED / MATCH / INGEST / PROPOSE
    const stages = new Set(calls.map((c) => c.stage));
    for (const stage of ['INGEST', 'REDACT', 'EMBED', 'MATCH', 'PROPOSE'])
      expect(stages.has(stage as AuditLogEntry['stage'])).toBe(true);

    // DLQ untouched on the success path
    expect(dlqSend).not.toHaveBeenCalled();
  });

  it('NEW path: low similarity → matcher consults the title generator and returns NEW with a draftTitle', async () => {
    const comprehend: ComprehendPort = { send: vi.fn(async () => ({ Entities: [] })) };
    const bedrock: BedrockPort = {
      send: vi.fn(async (_cmd: InvokeModelCommand) => {
        // The same Bedrock client serves both embedder and title-generator;
        // dispatch by command type.
        const ctor = (_cmd as { constructor: { name: string } }).constructor.name;
        if (
          ctor.includes('Embed') ||
          (_cmd as { input?: { modelId?: string } }).input?.modelId?.includes('embed')
        ) {
          return {
            body: new TextEncoder().encode(
              JSON.stringify({ embedding: new Array<number>(1024).fill(0.1) }),
            ),
          };
        }
        // Claude title generation response
        return {
          body: new TextEncoder().encode(
            JSON.stringify({ content: [{ text: 'Adding CSV exports' }] }),
          ),
        };
      }),
    };
    const { audit } = recordingAudit();
    const redact = createPiiRedactor({ comprehend, audit });
    const embedder = createEmbedder({ bedrock, audit });
    const generateDraftTitle = createTitleGenerator({ bedrock });

    // Matcher returns one far-away candidate → NEW path
    const dbQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'fi-2' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'be-x', linear_id: 'lin-x', title: 'Unrelated', distance: 0.6 }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    const db = { query: dbQuery } as unknown as Pool;

    const r = await processFeedbackItem(item, {
      db,
      audit,
      matcherDeps: { db, bedrockClient: {} as never, generateDraftTitle, audit },
      dlq: { sendMessage: vi.fn(async () => undefined) },
      redact,
      embed: (id, text) => embedder.embedSingle(id, text),
      match: findMatch,
    });
    expect(r.proposal.type).toBe('NEW');
    expect(r.proposal.backlogEntryId).toBeUndefined();
    expect(r.proposal.draftTitle).toBe('Adding CSV exports');
  });

  it('failure path: comprehend throws → DLQ records the failure with stage=PIPELINE and the error message', async () => {
    const comprehend: ComprehendPort = {
      send: vi.fn(async () => {
        throw new Error('Comprehend 503');
      }),
    };
    const bedrock: BedrockPort = { send: vi.fn() };
    const { audit } = recordingAudit();
    const redact = createPiiRedactor({ comprehend, audit });
    const embedder = createEmbedder({ bedrock, audit });
    const generateDraftTitle = createTitleGenerator({ bedrock });

    const db = { query: vi.fn() } as unknown as Pool;
    const dlqSend = vi.fn<(m: DlqMessage) => Promise<void>>(async () => undefined);

    await expect(
      processFeedbackItem(item, {
        db,
        audit,
        matcherDeps: { db, bedrockClient: {} as never, generateDraftTitle, audit },
        dlq: { sendMessage: dlqSend },
        redact,
        embed: (id, text) => embedder.embedSingle(id, text),
        match: findMatch,
      }),
    ).rejects.toThrow(/Comprehend 503/);

    expect(dlqSend).toHaveBeenCalledOnce();
    const msg = dlqSend.mock.calls[0]![0];
    expect(msg.stage).toBe('PIPELINE');
    expect(msg.error).toContain('Comprehend 503');
    expect(msg.source).toBe('slack');
    expect(msg.sourceItemId).toBe('C-feedback:1711992000.000001');
  });
});
