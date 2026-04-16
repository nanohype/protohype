import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

/**
 * DynamoDB-backed token bucket for GitHub API rate limiting.
 *
 * GitHub's limit: 5000 requests/hour per installation.
 * This bucket is shared across all concurrent Lambda instances via DynamoDB —
 * NOT in-memory per Lambda (which would allow each instance to use 5000/hr).
 *
 * Schema:
 *   PK: installationId (string)
 *   tokens: number — remaining tokens
 *   windowStart: number — epoch seconds when the current window started
 *   windowSizeSeconds: number — window duration (3600 for GitHub)
 *   capacity: number — max tokens per window (5000 for GitHub)
 */

export interface TokenBucketOptions {
  tableName: string;
  client: DynamoDBDocumentClient;
  windowSizeSeconds?: number; // default 3600
  capacity?: number; // default 5000
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  /** Epoch seconds when the window resets (only relevant when allowed = false) */
  resetAt?: number;
}

export class GitHubTokenBucket {
  private readonly table: string;
  private readonly ddb: DynamoDBDocumentClient;
  private readonly windowSizeSeconds: number;
  private readonly capacity: number;

  constructor(opts: TokenBucketOptions) {
    this.table = opts.tableName;
    this.ddb = opts.client;
    this.windowSizeSeconds = opts.windowSizeSeconds ?? 3600;
    this.capacity = opts.capacity ?? 5000;
  }

  /**
   * Attempt to consume `count` tokens for the given GitHub App installation.
   * Uses a DynamoDB conditional update (optimistic locking) to prevent races.
   *
   * Returns ConsumeResult.allowed = false if the bucket is exhausted.
   */
  async consume(installationId: string, count: number = 1): Promise<ConsumeResult> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = nowSeconds - (nowSeconds % this.windowSizeSeconds);
    const windowEnd = windowStart + this.windowSizeSeconds;

    // Try to atomically deduct tokens within the current window.
    // If windowStart has changed (new window), reset tokens to capacity first.
    try {
      const result = await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { installationId },
          UpdateExpression: `
            SET #tokens = if_not_exists(#tokens, :capacity) - :count,
                #windowStart = :windowStart,
                #capacity = :capacity,
                #windowSizeSeconds = :windowSizeSeconds
          `,
          ConditionExpression:
            // Either same window with enough tokens, or new window
            `(#windowStart = :windowStart AND #tokens >= :count) OR #windowStart < :windowStart`,
          ExpressionAttributeNames: {
            "#tokens": "tokens",
            "#windowStart": "windowStart",
            "#capacity": "capacity",
            "#windowSizeSeconds": "windowSizeSeconds",
          },
          ExpressionAttributeValues: {
            ":count": count,
            ":capacity": this.capacity - count,
            ":windowStart": windowStart,
            ":windowSizeSeconds": this.windowSizeSeconds,
          },
          ReturnValues: "ALL_NEW",
        })
      );

      const remaining = (result.Attributes?.["tokens"] as number | undefined) ?? 0;
      return { allowed: true, remaining };
    } catch (err: unknown) {
      // ConditionalCheckFailedException = bucket exhausted for this window
      if (isConditionalCheckFailed(err)) {
        const item = await this.peek(installationId);
        return {
          allowed: false,
          remaining: item?.tokens ?? 0,
          resetAt: windowEnd,
        };
      }
      throw err;
    }
  }

  /**
   * Peek at the current bucket state without consuming tokens.
   */
  async peek(installationId: string): Promise<{
    tokens: number;
    windowStart: number;
    capacity: number;
  } | null> {
    const { Item } = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { installationId },
      })
    );
    if (!Item) return null;
    return {
      tokens: (Item["tokens"] as number) ?? this.capacity,
      windowStart: (Item["windowStart"] as number) ?? 0,
      capacity: (Item["capacity"] as number) ?? this.capacity,
    };
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "ConditionalCheckFailedException"
  );
}
