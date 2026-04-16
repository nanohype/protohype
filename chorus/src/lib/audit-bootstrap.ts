import { SQSClient } from '@aws-sdk/client-sqs';
import { createQueueingAuditWriter, setDefaultAuditWriter } from './audit.js';
import { awsRegion } from './aws.js';
import { logger } from './observability.js';

/**
 * Startup helper: if `AUDIT_QUEUE_URL` is set, install the queueing
 * audit writer as the process-wide default so every `auditLog` call
 * enqueues to SQS instead of hitting RDS on the request path. A
 * separate consumer (`src/audit/audit-consumer.ts`) drains the queue.
 *
 * Callers invoke this once at startup — after any AWS credentials
 * are available, before the first pipeline stage runs.
 */
export function bootstrapAuditWriter(): void {
  const queueUrl = process.env['AUDIT_QUEUE_URL'];
  if (!queueUrl) {
    logger.info('audit writer mode', { mode: 'direct' });
    return;
  }
  const sqs = new SQSClient({ region: awsRegion() });
  setDefaultAuditWriter(createQueueingAuditWriter({ sqs, queueUrl }));
  logger.info('audit writer mode', { mode: 'queueing', queueUrl });
}
