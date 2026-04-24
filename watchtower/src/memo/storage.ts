import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { MemoRecord, MemoStatus, MemoStoragePort } from "./types.js";
import { MemoRecordSchema } from "./types.js";

// ── DynamoDB memo storage ──────────────────────────────────────────
//
// PK: memoId, SK: clientId (matches the CDK Memos table schema).
// `ConsistentRead: true` on `getConsistent` is required by the
// approval gate — eventual consistency would let an unapproved memo
// sneak past the gate during an operator approval race.
//
// `transition` uses a ConditionExpression on `status` to guarantee
// monotonic progression. Concurrent approvals on the same memo
// produce one winner and one `ConditionalCheckFailedException`.
//

export interface DdbMemoStorageDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
}

export function createDdbMemoStorage(deps: DdbMemoStorageDeps): MemoStoragePort {
  const { ddb, tableName } = deps;

  return {
    async create(memo) {
      const parsed = MemoRecordSchema.parse(memo);
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: parsed,
          ConditionExpression: "attribute_not_exists(memoId)",
        }),
      );
    },
    async getConsistent(memoId, clientId) {
      const result = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { memoId, clientId },
          ConsistentRead: true,
        }),
      );
      if (!result.Item) return null;
      const parsed = MemoRecordSchema.safeParse(result.Item);
      return parsed.success ? parsed.data : null;
    },
    async transition(memoId, clientId, from, update) {
      const names: Record<string, string> = { "#status": "status" };
      const values: Record<string, unknown> = { ":from": from, ":to": update.status };
      const setExprs: string[] = ["#status = :to"];
      let n = 0;
      for (const [k, v] of Object.entries(update)) {
        if (k === "status") continue;
        if (v === undefined) continue;
        n++;
        const nameKey = `#f${n}`;
        const valueKey = `:v${n}`;
        names[nameKey] = k;
        values[valueKey] = v;
        setExprs.push(`${nameKey} = ${valueKey}`);
      }
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { memoId, clientId },
          ConditionExpression: "#status = :from",
          UpdateExpression: "SET " + setExprs.join(", "),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    },
  };
}

// ── In-memory fake ─────────────────────────────────────────────────
export interface FakeMemoStorage extends MemoStoragePort {
  readonly memos: ReadonlyMap<string, MemoRecord>;
  seed(memo: MemoRecord): void;
  clear(): void;
}

const key = (memoId: string, clientId: string) => `${memoId}|${clientId}`;

export function createFakeMemoStorage(): FakeMemoStorage {
  const memos = new Map<string, MemoRecord>();
  return {
    async create(memo) {
      const k = key(memo.memoId, memo.clientId);
      if (memos.has(k)) {
        throw Object.assign(new Error("duplicate memo"), {
          name: "ConditionalCheckFailedException",
        });
      }
      memos.set(k, memo);
    },
    async getConsistent(memoId, clientId) {
      return memos.get(key(memoId, clientId)) ?? null;
    },
    async transition(memoId, clientId, from, update) {
      const k = key(memoId, clientId);
      const current = memos.get(k);
      if (!current || current.status !== from) {
        throw Object.assign(new Error(`status mismatch: want ${from}`), {
          name: "ConditionalCheckFailedException",
        });
      }
      memos.set(k, { ...current, ...update });
    },
    get memos() {
      return memos;
    },
    seed(memo) {
      memos.set(key(memo.memoId, memo.clientId), memo);
    },
    clear() {
      memos.clear();
    },
  };
}

/** Status transitions allowed by business rules. */
export const ALLOWED_TRANSITIONS: Readonly<Record<MemoStatus, readonly MemoStatus[]>> = {
  pending_review: ["approved", "rejected"],
  approved: ["published"],
  published: [],
  rejected: [],
};
