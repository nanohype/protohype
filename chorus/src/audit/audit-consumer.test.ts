import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@aws-sdk/client-sqs';
import type { Pool } from 'pg';
import { runAuditConsumer, type AuditSqsPort } from './audit-consumer.js';
import type { AuditLogEntry, AuditPort } from '../lib/audit.js';

function recordingAudit(): { audit: AuditPort; calls: AuditLogEntry[] } {
  const calls: AuditLogEntry[] = [];
  return { audit: async (e) => void calls.push(e), calls };
}

function sqsReturning(batches: Message[][]): {
  sqs: AuditSqsPort;
  deleted: string[];
} {
  let i = 0;
  const deleted: string[] = [];
  const sqs: AuditSqsPort = {
    receiveMessage: vi.fn(async () => batches[Math.min(i++, batches.length - 1)] ?? []),
    deleteMessage: vi.fn(async (_q: string, rh: string) => void deleted.push(rh)),
  };
  return { sqs, deleted };
}

describe('runAuditConsumer', () => {
  it('parses each message body as AuditLogEntry, writes it, and deletes the message', async () => {
    const entry: AuditLogEntry = { correlationId: 'c-1', stage: 'REDACT' };
    const { sqs, deleted } = sqsReturning([
      [{ MessageId: 'm1', Body: JSON.stringify(entry), ReceiptHandle: 'rh-1' }],
      [],
    ]);
    const { audit, calls } = recordingAudit();
    const controller = new AbortController();
    // Abort after the first empty-batch poll so the loop exits.
    let polls = 0;
    (sqs.receiveMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (polls++ === 1) controller.abort();
      return polls === 1
        ? [{ MessageId: 'm1', Body: JSON.stringify(entry), ReceiptHandle: 'rh-1' }]
        : [];
    });

    await runAuditConsumer({
      db: {} as unknown as Pool,
      sqs,
      queueUrl: 'https://sqs/q',
      audit,
      signal: controller.signal,
    });

    expect(calls).toEqual([entry]);
    expect(deleted).toEqual(['rh-1']);
  });

  it('leaves a message unacknowledged (no delete) when the writer throws', async () => {
    const entry: AuditLogEntry = { correlationId: 'c-2', stage: 'INGEST' };
    const { sqs, deleted } = sqsReturning([]);
    let polls = 0;
    const controller = new AbortController();
    (sqs.receiveMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (polls++ === 1) controller.abort();
      return polls === 1
        ? [{ MessageId: 'm2', Body: JSON.stringify(entry), ReceiptHandle: 'rh-2' }]
        : [];
    });

    const failingAudit: AuditPort = async () => {
      throw new Error('insert failed');
    };

    await runAuditConsumer({
      db: {} as unknown as Pool,
      sqs,
      queueUrl: 'https://sqs/q',
      audit: failingAudit,
      signal: controller.signal,
    });

    expect(deleted).toEqual([]);
  });
});
