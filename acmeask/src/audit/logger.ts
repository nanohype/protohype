/**
 * Audit event emitter — writes to AWS CloudWatch Logs for 1-year retention.
 * Write-once, no PII in content fields, async and non-blocking.
 */
import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { config } from '../config';
import { logger } from '../middleware/logger';
import type { AuditEvent } from '../types';

const cwClient = new CloudWatchLogsClient({ region: config.AWS_REGION });

const LOG_GROUP = config.CLOUDWATCH_LOG_GROUP;
const LOG_STREAM = `acmeask-${new Date().toISOString().slice(0, 10)}`;

export async function emitAuditEvent(event: AuditEvent): Promise<void> {
  // Fire-and-forget — do not block pipeline on audit log write
  setImmediate(() => {
    cwClient
      .send(
        new PutLogEventsCommand({
          logGroupName: LOG_GROUP,
          logStreamName: LOG_STREAM,
          logEvents: [
            {
              timestamp: Date.now(),
              message: JSON.stringify(event),
            },
          ],
        })
      )
      .catch((err) => {
        // Audit log failures must not break the user experience
        // but must be tracked by monitoring
        logger.error({ err, auditEventId: event.id }, 'AUDIT LOG WRITE FAILED — investigate immediately');
      });
  });
}
