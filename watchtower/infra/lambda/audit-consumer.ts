import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { SQSEvent, SQSBatchItemFailure, SQSBatchResponse } from "aws-lambda";

// ── Audit consumer ──────────────────────────────────────────────────
//
// Fans each SQS audit event out to two sinks:
//   1. DynamoDB hot table (90d TTL, fast queries by clientId + timestamp)
//   2. S3 archive bucket (long-term retention, lifecycle-managed)
//
// Both writes must succeed for a message to be acknowledged. Per-record
// failures are reported via `batchItemFailures` so SQS redrives only
// the failures — the rest of the batch is committed.
//

const TTL_SECONDS = 90 * 24 * 60 * 60;

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const AUDIT_TABLE = requireEnv("AUDIT_TABLE");
const AUDIT_BUCKET = requireEnv("AUDIT_BUCKET");

interface AuditEvent {
  readonly clientId?: string;
  readonly timestamp: string;
  readonly eventId?: string;
  readonly [key: string]: unknown;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const parsed = parseEvent(record.body);
      await writeDdb(parsed);
      await writeS3(parsed);
    } catch (err) {
      // Reported back to SQS so only this record is redriven. Message
      // eventually lands in the DLQ after maxReceiveCount redeliveries.
      console.error("audit-consumer record failed", {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

function parseEvent(body: string): AuditEvent {
  const raw = JSON.parse(body) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("audit event body is not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.timestamp !== "string") {
    throw new Error("audit event missing string `timestamp`");
  }
  return obj as AuditEvent;
}

async function writeDdb(ev: AuditEvent): Promise<void> {
  const clientId = ev.clientId ?? "_unknown";
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  await ddb.send(
    new PutItemCommand({
      TableName: AUDIT_TABLE,
      Item: {
        clientId: { S: clientId },
        timestamp: { S: ev.timestamp },
        eventData: { S: JSON.stringify(ev) },
        ttl: { N: String(ttl) },
      },
    }),
  );
}

async function writeS3(ev: AuditEvent): Promise<void> {
  const clientId = ev.clientId ?? "_unknown";
  const datePrefix = ev.timestamp.split("T")[0] ?? "unknown-date";
  const id = ev.eventId ?? ev.timestamp;
  const key = `audit/${clientId}/${datePrefix}/${id}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: AUDIT_BUCKET,
      Key: key,
      Body: JSON.stringify(ev),
      ContentType: "application/json",
    }),
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env var: ${name}`);
  return value;
}
