import type { Pool } from 'pg';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { getDbPool } from './db.js';
import type { SqsPort } from './queue.js';

export type AuditStage =
  | 'INGEST'
  | 'REDACT'
  | 'EMBED'
  | 'MATCH'
  | 'PROPOSE'
  | 'APPROVE'
  | 'REJECT'
  | 'CREATE'
  | 'DEFER'
  | 'LINEAR_CREATE';

export interface AuditLogEntry {
  correlationId: string;
  stage: AuditStage;
  actor?: string | undefined;
  feedbackItemId?: string | undefined;
  backlogEntryId?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

/** A port a pipeline / matcher / repository can take as a typed dep
 *  to record audit rows. Production callers receive the default
 *  `auditLog` (writes to the singleton `pg.Pool`); tests inject a
 *  `vi.fn<AuditPort>()` and assert on the AuditLogEntry shape. */
export type AuditPort = (entry: AuditLogEntry) => Promise<void>;

/**
 * Synchronous DB writer. Guaranteed delivery per call (awaited
 * INSERT), at the cost of per-stage RDS round-trip latency. This is
 * the compliance-first default. When throughput dominates, swap in
 * `createQueueingAuditWriter` at startup via `setDefaultAuditWriter`
 * and run `src/audit/audit-consumer.ts` against the queue.
 */
export function createAuditWriter(db: Pool): AuditPort {
  return async (entry: AuditLogEntry): Promise<void> => {
    await db.query(
      'INSERT INTO audit_log (correlation_id, stage, actor, feedback_item_id, backlog_entry_id, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        entry.correlationId,
        entry.stage,
        entry.actor ?? 'system',
        entry.feedbackItemId ?? null,
        entry.backlogEntryId ?? null,
        JSON.stringify(entry.detail ?? {}),
      ],
    );
  };
}

export interface QueueingAuditWriterDeps {
  sqs: SqsPort;
  queueUrl: string;
}

/**
 * Enqueues audit entries to SQS. The request-path cost is one SQS
 * `SendMessage` — no RDS round-trip. A separate consumer
 * (`audit-consumer.ts`) drains the queue and performs the INSERTs.
 *
 * Use this when hot-path latency matters more than strictly in-order,
 * strictly pre-response durability. Enqueue failures propagate to the
 * caller so the stage-level try/catch in the pipeline decides whether
 * to fall back, retry, or tombstone.
 */
export function createQueueingAuditWriter(deps: QueueingAuditWriterDeps): AuditPort {
  return async (entry: AuditLogEntry): Promise<void> => {
    await deps.sqs.send(
      new SendMessageCommand({
        QueueUrl: deps.queueUrl,
        MessageBody: JSON.stringify(entry),
      }),
    );
  };
}

let _override: AuditPort | undefined;

/**
 * Replace the process-wide default audit writer. Callers at startup
 * (api server, worker, digest job) use this to opt into the queueing
 * writer when `AUDIT_QUEUE_URL` is set. Subsequent calls to `auditLog`
 * dispatch through the override.
 */
export function setDefaultAuditWriter(writer: AuditPort): void {
  _override = writer;
}

/** Restore the direct-DB default. Tests call this in `afterEach`. */
export function resetDefaultAuditWriter(): void {
  _override = undefined;
}

/**
 * Module-level convenience for callers that don't inject an
 * AuditPort. Dispatches to the override if one was installed, else
 * does the synchronous DB insert.
 */
export const auditLog: AuditPort = (entry) =>
  _override ? _override(entry) : createAuditWriter(getDbPool())(entry);
