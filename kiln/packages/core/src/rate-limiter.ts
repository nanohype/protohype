import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export const RATE_LIMIT_TABLE =
  process.env['KILN_RATE_LIMIT_TABLE'] ?? 'kiln-rate-limits';

/** GitHub REST API limit per hour per installation token. */
const GITHUB_HOURLY_LIMIT = 5_000;

/** One-hour window in ms. */
const WINDOW_MS = 3_600_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix ms timestamp when the current window resets. */
  resetAt: number;
}

/**
 * Consume `cost` tokens from the centralised DynamoDB token bucket.
 *
 * Uses a conditional update so concurrent Lambda executions do not race:
 * - If count + cost > limit, the condition fails and we return `allowed: false`.
 * - Atomic: no window where tokens are double-spent.
 *
 * The bucket key is scoped per hour window so it auto-expires without a TTL.
 */
export async function consumeGitHubToken(
  client: DynamoDBDocumentClient,
  cost = 1,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const resetAt = windowStart + WINDOW_MS;
  const pk = `github-rate#${windowStart}`;

  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: RATE_LIMIT_TABLE,
        Key: { pk },
        UpdateExpression:
          'SET #count = if_not_exists(#count, :zero) + :cost, resetAt = :reset',
        ConditionExpression:
          'attribute_not_exists(#count) OR #count + :cost <= :limit',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: {
          ':zero': 0,
          ':cost': cost,
          ':limit': GITHUB_HOURLY_LIMIT,
          ':reset': resetAt,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    const newCount = (result.Attributes?.['count'] as number | undefined) ?? cost;
    return {
      allowed: true,
      remaining: GITHUB_HOURLY_LIMIT - newCount,
      resetAt,
    };
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e.name === 'ConditionalCheckFailedException') {
      return { allowed: false, remaining: 0, resetAt };
    }
    throw err;
  }
}
