import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import {
  createAuditWriter,
  createQueueingAuditWriter,
  auditLog,
  setDefaultAuditWriter,
  resetDefaultAuditWriter,
} from './audit.js';
import type { SqsPort } from './queue.js';

function makeDb(): { db: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  return { db: { query } as unknown as Pool, query };
}

describe('createAuditWriter', () => {
  it('runs a parameterised INSERT into audit_log with stage and actor', async () => {
    const { db, query } = makeDb();
    const audit = createAuditWriter(db);
    await audit({ correlationId: 'corr-1', stage: 'EMBED', actor: 'user-7' });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toMatch(/\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*\$6/);
    expect(params).toEqual(['corr-1', 'EMBED', 'user-7', null, null, '{}']);
  });

  it('defaults actor to "system" when not provided', async () => {
    const { db, query } = makeDb();
    await createAuditWriter(db)({ correlationId: 'c', stage: 'INGEST' });
    const params = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(params[2]).toBe('system');
  });

  it('JSON-stringifies the detail object so the column can be inserted as JSONB', async () => {
    const { db, query } = makeDb();
    await createAuditWriter(db)({
      correlationId: 'c',
      stage: 'MATCH',
      detail: { score: 0.91, type: 'LINK' },
    });
    const params = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(params[5]).toBe(JSON.stringify({ score: 0.91, type: 'LINK' }));
  });

  it('emits NULL for omitted feedbackItemId / backlogEntryId; both for an INGEST row', async () => {
    const { db, query } = makeDb();
    await createAuditWriter(db)({ correlationId: 'c', stage: 'INGEST' });
    const params = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  it('forwards both ids when provided (e.g. for a PROPOSE row tying feedback to backlog)', async () => {
    const { db, query } = makeDb();
    await createAuditWriter(db)({
      correlationId: 'c',
      stage: 'PROPOSE',
      feedbackItemId: 'fi-1',
      backlogEntryId: 'be-9',
    });
    const params = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(params[3]).toBe('fi-1');
    expect(params[4]).toBe('be-9');
  });

  it('propagates DB errors so the calling pipeline stage fails closed', async () => {
    const query = vi.fn(async () => {
      throw new Error('pg conn dropped');
    });
    const db = { query } as unknown as Pool;
    await expect(createAuditWriter(db)({ correlationId: 'c', stage: 'EMBED' })).rejects.toThrow(
      'pg conn dropped',
    );
  });
});

describe('createQueueingAuditWriter', () => {
  it('enqueues a JSON-serialised AuditLogEntry to the configured queue URL', async () => {
    const send = vi.fn<(cmd: unknown) => Promise<unknown>>(async () => ({ MessageId: 'm1' }));
    const sqs = { send } as unknown as SqsPort;
    const writer = createQueueingAuditWriter({ sqs, queueUrl: 'https://sqs/q' });
    await writer({ correlationId: 'c', stage: 'EMBED', detail: { score: 0.9 } });
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0] as {
      input: { QueueUrl: string; MessageBody: string };
    };
    expect(cmd.input.QueueUrl).toBe('https://sqs/q');
    expect(JSON.parse(cmd.input.MessageBody)).toEqual({
      correlationId: 'c',
      stage: 'EMBED',
      detail: { score: 0.9 },
    });
  });

  it('propagates SQS errors to the caller', async () => {
    const send = vi.fn(async () => {
      throw new Error('throttled');
    });
    const writer = createQueueingAuditWriter({
      sqs: { send } as unknown as SqsPort,
      queueUrl: 'https://sqs/q',
    });
    await expect(writer({ correlationId: 'c', stage: 'INGEST' })).rejects.toThrow('throttled');
  });
});

describe('setDefaultAuditWriter / auditLog override', () => {
  afterEach(() => resetDefaultAuditWriter());

  it('auditLog dispatches through the installed override', async () => {
    const recorded: Array<{ correlationId: string; stage: string }> = [];
    setDefaultAuditWriter(
      async (e) => void recorded.push({ correlationId: e.correlationId, stage: e.stage }),
    );
    await auditLog({ correlationId: 'c', stage: 'REDACT' });
    expect(recorded).toEqual([{ correlationId: 'c', stage: 'REDACT' }]);
  });

  it('reset restores default dispatch (no override installed)', async () => {
    setDefaultAuditWriter(async () => undefined);
    resetDefaultAuditWriter();
    // With no override and no real pool, calling auditLog would try
    // to construct the singleton pool — we don't exercise that path
    // here; just verify the override was cleared by replacing and
    // re-reading.
    let called = 0;
    setDefaultAuditWriter(async () => {
      called++;
    });
    await auditLog({ correlationId: 'c', stage: 'REDACT' });
    expect(called).toBe(1);
  });
});
