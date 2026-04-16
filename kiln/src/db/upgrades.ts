/**
 * Upgrade ledger repository.
 * Partition key: teamId. Sort key: upgradeId.
 * Audit writes are awaited — no fire-and-forget.
 */
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "./client.js";
import { config } from "../config.js";
import type { UpgradeRecord, UpgradeStatus, PatchedFile, HumanReviewItem, BreakingChange } from "../types.js";

const TABLE = config.dynamodb.upgradesTable;

export async function putUpgradeRecord(record: UpgradeRecord): Promise<void> {
  const client = getDocumentClient();
  // Awaited — audit write must land before returning
  await client.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...record, updatedAt: new Date().toISOString() },
    }),
  );
}

export async function getUpgradeRecord(
  teamId: string,
  upgradeId: string,
): Promise<UpgradeRecord | null> {
  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({
      TableName: TABLE,
      Key: { teamId, upgradeId },
    }),
  );
  return (result.Item as UpgradeRecord) ?? null;
}

export async function updateUpgradeStatus(
  teamId: string,
  upgradeId: string,
  status: UpgradeStatus,
  extra: Partial<{
    prNumber: number;
    prUrl: string;
    changelogUrls: string[];
    breakingChanges: BreakingChange[];
    patchedFiles: PatchedFile[];
    humanReviewItems: HumanReviewItem[];
    errorMessage: string;
  }> = {},
): Promise<void> {
  const client = getDocumentClient();
  const now = new Date().toISOString();

  const updates: string[] = ["#s = :status", "#ua = :updatedAt"];
  const names: Record<string, string> = { "#s": "status", "#ua": "updatedAt" };
  const values: Record<string, unknown> = { ":status": status, ":updatedAt": now };

  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) {
      updates.push(`#${k} = :${k}`);
      names[`#${k}`] = k;
      values[`:${k}`] = v;
    }
  }

  // Awaited — audit write must land
  await client.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { teamId, upgradeId },
      UpdateExpression: `SET ${updates.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function listUpgradesByTeam(
  teamId: string,
  limit = 50,
): Promise<UpgradeRecord[]> {
  const client = getDocumentClient();
  const { Items = [] } = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "teamId = :t",
      ExpressionAttributeValues: { ":t": teamId },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }),
  );
  return Items as UpgradeRecord[];
}
