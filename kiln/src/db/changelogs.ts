/**
 * Vendor changelog cache — DynamoDB-backed with TTL.
 * Partition key: dep. Sort key: version.
 */
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "./client.js";
import { config } from "../config.js";
import type { ChangelogEntry } from "../types.js";

const TABLE = config.dynamodb.changelogsTable;
// Cache changelogs for 7 days
const CHANGELOG_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function getCachedChangelog(
  dep: string,
  version: string,
): Promise<ChangelogEntry | null> {
  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({
      TableName: TABLE,
      Key: { dep, version },
    }),
  );
  if (!result.Item) return null;
  const entry = result.Item as ChangelogEntry;
  // Check TTL ourselves (DynamoDB TTL deletion can lag up to 48h)
  if (entry.expiresAt < Math.floor(Date.now() / 1000)) return null;
  return entry;
}

export async function putChangelogCache(
  entry: Omit<ChangelogEntry, "expiresAt">,
): Promise<void> {
  const client = getDocumentClient();
  const record: ChangelogEntry = {
    ...entry,
    expiresAt: Math.floor(Date.now() / 1000) + CHANGELOG_TTL_SECONDS,
  };
  await client.send(
    new PutCommand({
      TableName: TABLE,
      Item: record,
    }),
  );
}
