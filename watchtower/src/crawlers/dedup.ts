import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DedupPort } from "./types.js";

// ── DynamoDB dedup adapter ─────────────────────────────────────────
//
// Keyed on (sourceId, contentHash). Every crawler run asks "have I
// seen this before?" before emitting a RuleChange. Missing rows are
// written with ConditionExpression=attribute_not_exists, so racing
// crawlers (two tasks, same message) don't double-emit.
//

export interface DdbDedupDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
}

export function createDdbDedup(deps: DdbDedupDeps): DedupPort {
  const { ddb, tableName } = deps;

  return {
    async seen(sourceId, contentHash) {
      const result = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { sourceId, contentHash },
          ProjectionExpression: "sourceId",
        }),
      );
      return Boolean(result.Item);
    },
    async markSeen(sourceId, contentHash, meta) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              sourceId,
              contentHash,
              url: meta.url,
              title: meta.title,
              firstSeenAt: meta.firstSeenAt,
            },
            ConditionExpression:
              "attribute_not_exists(sourceId) AND attribute_not_exists(contentHash)",
          }),
        );
      } catch (err: unknown) {
        // ConditionalCheckFailedException means another worker beat us —
        // that's fine, the row is marked and we're idempotent.
        const name = (err as { name?: string })?.name;
        if (name === "ConditionalCheckFailedException") return;
        throw err;
      }
    },
  };
}

// ── In-memory dedup for tests ──────────────────────────────────────
export interface FakeDedup extends DedupPort {
  readonly entries: ReadonlyArray<{ sourceId: string; contentHash: string }>;
  clear(): void;
}

export function createFakeDedup(): FakeDedup {
  const map = new Map<string, { url: string; title: string; firstSeenAt: string }>();
  const key = (s: string, h: string) => `${s}|${h}`;
  return {
    async seen(sourceId, contentHash) {
      return map.has(key(sourceId, contentHash));
    },
    async markSeen(sourceId, contentHash, meta) {
      // Preserve first-seen — don't overwrite on race.
      if (!map.has(key(sourceId, contentHash))) map.set(key(sourceId, contentHash), meta);
    },
    get entries() {
      return [...map.keys()].map((k) => {
        const [sourceId, contentHash] = k.split("|", 2) as [string, string];
        return { sourceId, contentHash };
      });
    },
    clear() {
      map.clear();
    },
  };
}
