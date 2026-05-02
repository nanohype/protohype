// DynamoDB-backed token bucket — shared across Lambda instances. Conditional
// UpdateItem is the atomicity primitive: two concurrent tryAcquire calls can
// never both take the last token.

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { RateLimiterPort } from "../../core/ports.js";

interface BucketState {
  bucketKey: string;
  tokens: number;
  updatedAt: number; // ms
}

export function makeRateLimiterAdapter(
  doc: DynamoDBDocumentClient,
  tableName: string,
): RateLimiterPort {
  return {
    async tryAcquire(bucketKey: string, capacity: number, refillPerSec: number): Promise<boolean> {
      const now = Date.now();

      // Optimistic: read → compute → conditional write. Retry on contention.
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await readState(doc, tableName, bucketKey);
        const refilled = refill(current, capacity, refillPerSec, now);
        if (refilled.tokens < 1) return false;
        const next: BucketState = { bucketKey, tokens: refilled.tokens - 1, updatedAt: now };
        const prevUpdatedAt = current?.updatedAt;
        const written = await writeConditional(doc, tableName, next, prevUpdatedAt);
        if (written) return true;
      }
      return false;
    },
  };
}

async function readState(
  doc: DynamoDBDocumentClient,
  tableName: string,
  bucketKey: string,
): Promise<BucketState | undefined> {
  // We pack the read into the same UpdateItem path by doing a probe write; to
  // keep logic simple here, we use a separate Get equivalent via a no-op update
  // is overkill — use GetCommand instead.
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const resp = await doc.send(new GetCommand({ TableName: tableName, Key: { bucketKey } }));
  return resp.Item as BucketState | undefined;
}

function refill(
  current: BucketState | undefined,
  capacity: number,
  refillPerSec: number,
  now: number,
): BucketState {
  if (!current) return { bucketKey: "", tokens: capacity, updatedAt: now };
  const elapsedSec = Math.max(0, (now - current.updatedAt) / 1000);
  const tokens = Math.min(capacity, current.tokens + elapsedSec * refillPerSec);
  return { bucketKey: current.bucketKey, tokens, updatedAt: current.updatedAt };
}

async function writeConditional(
  doc: DynamoDBDocumentClient,
  tableName: string,
  next: BucketState,
  prevUpdatedAt: number | undefined,
): Promise<boolean> {
  try {
    const condition = prevUpdatedAt === undefined
      ? "attribute_not_exists(bucketKey)"
      : "updatedAt = :prev";
    await doc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { bucketKey: next.bucketKey },
        UpdateExpression: "SET tokens = :t, updatedAt = :u",
        ConditionExpression: condition,
        ExpressionAttributeValues: prevUpdatedAt === undefined
          ? { ":t": next.tokens, ":u": next.updatedAt }
          : { ":t": next.tokens, ":u": next.updatedAt, ":prev": prevUpdatedAt },
      }),
    );
    return true;
  } catch (e) {
    if (typeof e === "object" && e !== null && "name" in e && (e as { name: string }).name === "ConditionalCheckFailedException") {
      return false;
    }
    throw e;
  }
}
