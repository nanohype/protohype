/**
 * Shared GitHub API rate limiter — token-bucket backed by DynamoDB.
 *
 * Multi-instance safe: all Lambda instances share the same DynamoDB item.
 * GitHub allows 5 000 requests/hour per installation token.
 * We reserve a 10% safety margin → effective cap is 4 500/hour.
 *
 * The bucket refills at (capacity / windowSeconds) tokens per second.
 * We use a conditional UpdateItem to atomically decrement; if the count
 * would go negative we throw RateLimitExceeded.
 */
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { docClient, TABLE_NAMES } from './dynamo';

const CAPACITY = 4_500;            // tokens per window
const WINDOW_SECONDS = 3_600;      // 1 hour
const REFILL_RATE = CAPACITY / WINDOW_SECONDS; // tokens per second

export class RateLimitExceeded extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`GitHub API rate limit reached. Retry after ${retryAfterSeconds}s.`);
    this.name = 'RateLimitExceeded';
  }
}

interface BucketItem {
  bucketKey: string;
  tokens: number;
  lastRefillAt: number;  // Unix timestamp (seconds)
}

/**
 * Consume `count` tokens from the bucket identified by `bucketKey`.
 * Typically bucketKey = `github-api:{orgId}` — one bucket per GitHub org.
 * Throws RateLimitExceeded if insufficient tokens remain.
 */
export async function consumeTokens(bucketKey: string, count = 1): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // 1. Read current bucket state
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAMES.RATE_LIMITER,
    Key: { bucketKey },
    ConsistentRead: true,
  }));

  let tokens: number;
  let lastRefill: number;

  if (!result.Item) {
    // First use — initialise full bucket
    tokens = CAPACITY;
    lastRefill = now;
  } else {
    const item = result.Item as BucketItem;
    const elapsed = now - item.lastRefillAt;
    tokens = Math.min(CAPACITY, item.tokens + elapsed * REFILL_RATE);
    lastRefill = now;
  }

  if (tokens < count) {
    const deficit = count - tokens;
    const retryAfter = Math.ceil(deficit / REFILL_RATE);
    throw new RateLimitExceeded(retryAfter);
  }

  const newTokens = tokens - count;

  // 2. Atomic conditional write — detect if another instance changed the bucket
  //    between our read and write.  On conflict we retry once (optimistic locking).
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAMES.RATE_LIMITER,
      Key: { bucketKey },
      UpdateExpression: 'SET tokens = :tokens, lastRefillAt = :now',
      ConditionExpression: 'attribute_not_exists(bucketKey) OR tokens = :expectedTokens',
      ExpressionAttributeValues: {
        ':tokens': newTokens,
        ':now': lastRefill,
        ':expectedTokens': result.Item ? (result.Item as BucketItem).tokens : CAPACITY,
      },
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Lost the race — retry with fresh state
      return consumeTokens(bucketKey, count);
    }
    throw err;
  }
}
