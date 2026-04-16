/**
 * GitHub API rate limiter — DynamoDB-backed token bucket.
 * Shared across all Lambda instances so the 5000/hour limit is respected globally.
 * In-memory rate limiting is forbidden on multi-instance deployments.
 */
import {
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { getDocumentClient } from "../../db/client.js";
import { config } from "../../config.js";
import { log } from "../../telemetry/otel.js";

const TABLE = config.dynamodb.rateLimitTable;
const BUCKET_KEY = "github-api";
const REFILL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class RateLimitExceededError extends Error {
  constructor(remaining: number) {
    super(`GitHub rate limit exceeded. Tokens remaining: ${remaining}`);
    this.name = "RateLimitExceededError";
  }
}

/**
 * Consume n tokens from the shared DynamoDB token bucket.
 * Uses conditional writes to handle concurrent Lambda instances.
 * Throws RateLimitExceededError if insufficient tokens.
 */
export async function consumeGitHubTokens(count: number): Promise<void> {
  const client = getDocumentClient();
  const nowMs = Date.now();

  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await client.send(
      new GetCommand({ TableName: TABLE, Key: { key: BUCKET_KEY } }),
    );

    let tokens: number;
    let lastRefillAt: number;

    if (!result.Item) {
      // First use — initialize bucket
      tokens = config.github.rateLimitPerHour;
      lastRefillAt = nowMs;
    } else {
      tokens = result.Item["tokens"] as number;
      lastRefillAt = result.Item["lastRefillAt"] as number;

      // Refill if a full hour has passed
      if (nowMs - lastRefillAt >= REFILL_INTERVAL_MS) {
        tokens = config.github.rateLimitPerHour;
        lastRefillAt = nowMs;
      }
    }

    if (tokens < count) {
      throw new RateLimitExceededError(tokens);
    }

    // Conditional update — retry on conflict (concurrent Lambda consumed tokens)
    try {
      await client.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { key: BUCKET_KEY },
          UpdateExpression: "SET #t = :newTokens, #lr = :lastRefillAt",
          ConditionExpression: result.Item
            ? "#t = :currentTokens AND #lr = :currentLastRefill"
            : "attribute_not_exists(#k)",
          ExpressionAttributeNames: {
            "#t": "tokens",
            "#lr": "lastRefillAt",
            "#k": "key",
          },
          ExpressionAttributeValues: {
            ":newTokens": tokens - count,
            ":lastRefillAt": lastRefillAt,
            ...(result.Item
              ? {
                  ":currentTokens": tokens,
                  ":currentLastRefill": lastRefillAt,
                }
              : {}),
          },
        }),
      );
      return; // success
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        log("info", "Rate limit CAS conflict — retrying", { attempt });
        // Exponential backoff with jitter
        await sleep(50 * Math.pow(2, attempt) + Math.random() * 50);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Failed to acquire GitHub rate limit tokens after 5 attempts");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
