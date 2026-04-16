import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import type { Pool } from 'pg';
import { getDbPool, closeDbPool } from '../lib/db.js';
import { createAuditWriter, type AuditLogEntry, type AuditPort } from '../lib/audit.js';
import { logger } from '../lib/observability.js';
import { awsRegion } from '../lib/aws.js';

/**
 * Port over the SQS client surface the consumer needs. Tests inject a
 * fake implementing just these three methods — no `vi.mock` of the
 * SDK module.
 */
export interface AuditSqsPort {
  receiveMessage(queueUrl: string): Promise<Message[]>;
  deleteMessage(queueUrl: string, receiptHandle: string): Promise<void>;
}

export interface AuditConsumerDeps {
  db: Pool;
  sqs: AuditSqsPort;
  queueUrl: string;
  /** Override the writer to e.g. record audit entries in tests. */
  audit?: AuditPort;
  /** Poll signal — when set to `abort`, the consumer drains its
   *  current batch then exits. */
  signal?: AbortSignal;
}

function defaultSqsPort(): AuditSqsPort {
  const client = new SQSClient({ region: awsRegion() });
  return {
    async receiveMessage(queueUrl) {
      const r = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
        }),
      );
      return r.Messages ?? [];
    },
    async deleteMessage(queueUrl, receiptHandle) {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
      );
    },
  };
}

/**
 * Long-running consumer: polls SQS, writes each message's audit entry
 * to the DB, deletes the message on success. Messages that fail to
 * parse or insert are left to SQS redrive (do not DeleteMessage).
 */
export async function runAuditConsumer(deps: AuditConsumerDeps): Promise<void> {
  const writer = deps.audit ?? createAuditWriter(deps.db);

  while (!deps.signal?.aborted) {
    let messages: Message[];
    try {
      messages = await deps.sqs.receiveMessage(deps.queueUrl);
    } catch (err) {
      logger.error('audit consumer receive failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const msg of messages) {
      if (!msg.Body || !msg.ReceiptHandle) continue;
      try {
        const entry = JSON.parse(msg.Body) as AuditLogEntry;
        await writer(entry);
        await deps.sqs.deleteMessage(deps.queueUrl, msg.ReceiptHandle);
      } catch (err) {
        logger.error('audit consumer insert failed', {
          messageId: msg.MessageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

async function main(): Promise<void> {
  const queueUrl = process.env['AUDIT_QUEUE_URL'];
  if (!queueUrl) throw new Error('AUDIT_QUEUE_URL is required');

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  const db = getDbPool();
  logger.info('audit consumer start', { queueUrl });
  await runAuditConsumer({ db, sqs: defaultSqsPort(), queueUrl, signal: controller.signal });
  await closeDbPool();
  logger.info('audit consumer stop');
}

const isCli = import.meta.url === `file://${process.argv[1] ?? ''}`;
if (isCli) {
  main().catch((err: unknown) => {
    logger.error('audit consumer fatal', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
