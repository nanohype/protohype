/**
 * Audit log writer.
 *
 * Every write is AWAITED — no fire-and-forget.
 * On DynamoDB throttle the write goes to the audit DLQ (SQS) so the
 * compliance trail is never silently dropped.
 */
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import { docClient, TABLE_NAMES } from './dynamo';
import type { AuditAction, AuditEvent } from './types';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const AUDIT_DLQ_URL = process.env.KILN_AUDIT_DLQ_URL ?? '';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

const sqsClient = new SQSClient({
  region: REGION,
  requestHandler: {
    requestTimeout: 5_000,
  } as { requestTimeout: number },
});

/**
 * Write an audit event.
 * Blocking — callers must await.
 * Falls back to SQS DLQ on DynamoDB ProvisionedThroughputExceededException / throttle.
 */
export async function writeAuditEvent(params: {
  teamId: string;
  action: AuditAction;
  actorIdentity: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  const uuid = randomUUID();
  const event: AuditEvent = {
    teamId: params.teamId,
    eventId: `${now.toISOString()}#${uuid}`,
    action: params.action,
    actorIdentity: params.actorIdentity,
    metadata: params.metadata ?? {},
    createdAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + ONE_YEAR_SECONDS,
  };

  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAMES.AUDIT_LOG,
      Item: event,
    }));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // On throttle / provisioned-throughput errors, route to DLQ
    if (AUDIT_DLQ_URL) {
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: AUDIT_DLQ_URL,
        MessageBody: JSON.stringify(event),
        MessageAttributes: {
          DynamoError: {
            DataType: 'String',
            StringValue: errMsg,
          },
        },
      }));
    } else {
      // Re-throw so the calling Lambda fails visibly — silent drops are unacceptable
      throw new Error(`Audit write failed and no DLQ configured: ${errMsg}`);
    }
  }
}
