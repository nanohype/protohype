// GitHub App installation-token cache — keyed on installationId, TTL'd by DDB.
// Shared across Lambda invocations so cold starts don't re-mint tokens and
// hit the App-JWT rate limit.

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

interface TokenCacheItem {
  installationId: number;
  token: string;
  expiresAt: number; // epoch seconds, DDB TTL attribute
}

export interface GithubTokenCache {
  get(installationId: number): Promise<{ token: string; expiresAt: Date } | null>;
  put(installationId: number, token: string, expiresAt: Date): Promise<void>;
}

export function makeGithubTokenCache(
  doc: DynamoDBDocumentClient,
  tableName: string,
): GithubTokenCache {
  return {
    async get(installationId) {
      const resp = await doc.send(
        new GetCommand({ TableName: tableName, Key: { installationId } }),
      );
      const item = resp.Item as TokenCacheItem | undefined;
      if (!item) return null;
      const expiresAt = new Date(item.expiresAt * 1000);
      // Require at least 60s of life left so callers aren't handed a token
      // that expires mid-request.
      if (expiresAt.getTime() - Date.now() < 60_000) return null;
      return { token: item.token, expiresAt };
    },
    async put(installationId, token, expiresAt) {
      // 50-minute cap on stored TTL for 60-minute tokens; gives us headroom.
      const cappedExpSec = Math.min(
        Math.floor(expiresAt.getTime() / 1000),
        Math.floor((Date.now() + 50 * 60 * 1000) / 1000),
      );
      const item: TokenCacheItem = { installationId, token, expiresAt: cappedExpSec };
      await doc.send(new PutCommand({ TableName: tableName, Item: item }));
    },
  };
}
