/**
 * Audit Logger — SQS fire-and-forget, question SHA-256 hashed (never stored raw)
 *
 * Write path: app → SQS → Lambda audit-writer → DynamoDB (TTL 365 days)
 * DLQ after 3 failures → PagerDuty alert
 * Immutable — no delete API
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createHash, randomUUID } from 'crypto';

export interface AuditEvent {
  slackUserId: string;
  oktaUserId: string;
  question: string;    // hashed before SQS send — never stored raw
  retrievedDocIds: string[];
  answerText: string;  // hashed before SQS send
  connectorStatuses: Record<string, string>;
  latencyMs: number;
}

export class AuditLogger {
  private sqs: SQSClient;
  private queueUrl: string;

  constructor(config: { region: string; queueUrl: string }) {
    this.sqs = new SQSClient({ region: config.region });
    this.queueUrl = config.queueUrl;
  }

  async log(event: AuditEvent): Promise<void> {
    const record = {
      queryId: randomUUID(),
      slackUserId: event.slackUserId,
      oktaUserId: event.oktaUserId,
      questionHash: sha256(event.question),
      retrievedDocIds: event.retrievedDocIds,
      answerHash: sha256(event.answerText),
      connectorStatuses: event.connectorStatuses,
      latencyMs: event.latencyMs,
      timestamp: new Date().toISOString(),
    };

    // PR-02 fix: explicit void + catch on fire-and-forget
    void this.sqs
      .send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(record) }))
      .catch(err => console.error('[audit] SQS send failed', { error: err, queryId: record.queryId }));
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}
