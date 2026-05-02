// Changelog cache — globally shared across tenants by design. Changelogs are
// public data from public repos; partitioning by teamId would waste budget.
// See ADR 0005 for rationale; the "every query scoped on teamId" invariant
// does NOT apply to this table.

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ChangelogCachePort } from "../../core/ports.js";

interface CacheItem {
  cacheKey: string;
  body: string;
  fetchedAt: string;
  expiresAt: number; // epoch seconds, DDB TTL attribute
}

export function makeChangelogCacheAdapter(
  doc: DynamoDBDocumentClient,
  tableName: string,
): ChangelogCachePort {
  return {
    async get(cacheKey) {
      const resp = await doc.send(new GetCommand({ TableName: tableName, Key: { cacheKey } }));
      const item = resp.Item as CacheItem | undefined;
      if (!item) return null;
      // Belt-and-suspenders; DDB TTL is eventually consistent so filter here too.
      if (item.expiresAt * 1000 < Date.now()) return null;
      return { body: item.body, fetchedAt: item.fetchedAt };
    },
    async put(cacheKey, body, ttlSeconds) {
      const item: CacheItem = {
        cacheKey,
        body,
        fetchedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
      };
      await doc.send(new PutCommand({ TableName: tableName, Item: item }));
    },
  };
}
