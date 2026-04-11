import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE_NAME } from "../db/client";
import { toolResult, McpToolResult } from "../mcp/protocol";

export interface ListArgs {
  agentId: string;
  limit?: number;
  cursor?: string;
  tags?: string[];
}

export async function listMemories(args: ListArgs): Promise<McpToolResult> {
  const { agentId, limit = 20, cursor, tags = [] } = args;

  const pageSize = Math.min(Math.max(1, limit), 100);

  // Decode the pagination cursor (base64-encoded JSON of LastEvaluatedKey)
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (cursor) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(cursor, "base64").toString("utf8")
      ) as Record<string, unknown>;
    } catch {
      return toolResult("Invalid pagination cursor", true);
    }
  }

  // Use the GSI to list newest-first
  const resp = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "agentId-createdAt-index",
      KeyConditionExpression: "agentId = :aid",
      ExpressionAttributeValues: { ":aid": agentId },
      ScanIndexForward: false, // descending by createdAt
      Limit: pageSize,
      ExclusiveStartKey: exclusiveStartKey,
    })
  );

  interface RawItem {
    memoryId: string;
    content: string;
    metadata: string;
    tags?: string[];
    createdAt: string;
  }

  let items = (resp.Items as RawItem[]) ?? [];

  // Client-side tag filter (DynamoDB doesn't support set-contains in KeyCondition)
  if (tags.length > 0) {
    items = items.filter((item) =>
      tags.every((t) => (item.tags ?? []).includes(t))
    );
  }

  const memories = items.map((item) => ({
    memoryId: item.memoryId,
    content: item.content,
    metadata: (() => {
      try {
        return JSON.parse(item.metadata);
      } catch {
        return {};
      }
    })(),
    tags: item.tags ?? [],
    createdAt: item.createdAt,
  }));

  // Encode next cursor
  const nextCursor = resp.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(resp.LastEvaluatedKey)).toString("base64")
    : null;

  return toolResult(
    JSON.stringify({
      memories,
      count: memories.length,
      ...(nextCursor ? { nextCursor } : {}),
    })
  );
}
