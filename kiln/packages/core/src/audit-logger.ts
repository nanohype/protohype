import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

export const AUDIT_TABLE =
  process.env['KILN_AUDIT_TABLE'] ?? 'kiln-audit-log';

/** One year in seconds. DynamoDB TTL. */
const AUDIT_TTL_SECS = 365 * 24 * 3_600;

export type AuditEventType =
  | 'PR_OPENED'
  | 'CONFIG_READ'
  | 'CONFIG_WRITTEN'
  | 'CHANGELOG_FETCHED'
  | 'UPGRADE_TRIGGERED'
  | 'BREAKING_CHANGE_FLAGGED'
  | 'RATE_LIMIT_EXCEEDED';

export interface AuditEvent {
  eventId: string;
  eventType: AuditEventType;
  /** Partition key — per-tenant isolation. */
  teamId: string;
  actor: string;
  timestamp: string;
  payload: Record<string, unknown>;
  /** Unix seconds TTL — items expire after 1 year. */
  ttl: number;
}

/**
 * Write an audit event to DynamoDB.
 *
 * IMPORTANT: This call is always awaited — never fire-and-forget.
 * If you need lower latency, write to a local WAL first and drain async.
 * Silently dropping the audit trail is a compliance failure.
 */
export async function writeAuditEvent(
  eventType: AuditEventType,
  teamId: string,
  actor: string,
  payload: Record<string, unknown>,
  client: DynamoDBDocumentClient,
): Promise<void> {
  const event: AuditEvent = {
    eventId: randomUUID(),
    eventType,
    teamId,
    actor,
    timestamp: new Date().toISOString(),
    payload,
    ttl: Math.floor(Date.now() / 1_000) + AUDIT_TTL_SECS,
  };

  // Blocking write — compliance trail must not be lost
  await client.send(
    new PutCommand({
      TableName: AUDIT_TABLE,
      Item: event,
    }),
  );
}
