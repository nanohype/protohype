import { ScanCommand, GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Logger } from "../logger.js";
import type { ClientConfig, ClientsPort } from "./types.js";
import { ClientConfigSchema } from "./types.js";

// ── DynamoDB clients repository ─────────────────────────────────────
//
// Reads client config rows from DynamoDB. Each row has `clientId` as
// partition key and the full config as a nested attribute `data`.
// We keep the shape flat-ish so operators can inspect rows in the
// AWS console without tooling.
//
// The cache is deliberately tiny (60s TTL) — classifier runs on
// every rule change and `listActive()` is hot. A longer TTL invites
// stale-config bugs that surface only when a newly-onboarded client
// fails to see alerts.
//

export interface DdbClientsDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
  readonly logger: Logger;
  readonly cacheTtlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

export function createDdbClientsRepo(deps: DdbClientsDeps): ClientsPort {
  const { ddb, tableName, logger, cacheTtlMs = DEFAULT_TTL_MS } = deps;
  let cache: { at: number; rows: readonly ClientConfig[] } | null = null;

  async function loadAll(): Promise<readonly ClientConfig[]> {
    if (cache && Date.now() - cache.at < cacheTtlMs) return cache.rows;

    // DDB Scan is fine here: watchtower expects single-digit to low-hundreds
    // of clients per tenant of this skeleton. At scale, swap to a secondary
    // index on `active` or a materialized list — but don't add complexity
    // before the use case demands it.
    const result = await ddb.send(new ScanCommand({ TableName: tableName, ConsistentRead: false }));
    const rows: ClientConfig[] = [];
    for (const item of result.Items ?? []) {
      const parsed = ClientConfigSchema.safeParse(item);
      if (parsed.success) {
        rows.push(parsed.data);
      } else {
        logger.warn("malformed client row — skipping", {
          clientId: (item as { clientId?: string }).clientId ?? "(unknown)",
          issues: parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message),
        });
      }
    }
    cache = { at: Date.now(), rows };
    return rows;
  }

  return {
    async listActive(): Promise<readonly ClientConfig[]> {
      const rows = await loadAll();
      return rows.filter((c) => c.active);
    },
    async get(clientId: string): Promise<ClientConfig | null> {
      // Direct GetItem for single-client lookup — cheaper than Scan,
      // avoids cache dependency for fresh reads of a specific client.
      const result = await ddb.send(new GetCommand({ TableName: tableName, Key: { clientId } }));
      if (!result.Item) return null;
      const parsed = ClientConfigSchema.safeParse(result.Item);
      if (!parsed.success) {
        logger.warn("malformed client row on direct get", {
          clientId,
          issues: parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message),
        });
        return null;
      }
      return parsed.data.active ? parsed.data : null;
    },
  };
}
