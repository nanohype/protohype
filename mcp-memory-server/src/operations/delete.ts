import { DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE_NAME } from "../db/client";
import { toolResult, McpToolResult } from "../mcp/protocol";

export interface DeleteArgs {
  agentId: string;
  memoryId: string;
}

export async function deleteMemory(args: DeleteArgs): Promise<McpToolResult> {
  const { agentId, memoryId } = args;

  if (!agentId || !memoryId) {
    return toolResult("agentId and memoryId are required", true);
  }

  // Verify the item exists and belongs to the given agentId before deleting
  const existing = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { agentId, memoryId },
    })
  );

  if (!existing.Item) {
    return toolResult(
      JSON.stringify({ deleted: false, reason: "Memory not found" }),
      true
    );
  }

  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { agentId, memoryId },
      // Guard against race conditions — ensure PK still matches
      ConditionExpression: "agentId = :aid",
      ExpressionAttributeValues: { ":aid": agentId },
    })
  );

  return toolResult(JSON.stringify({ deleted: true, memoryId, agentId }));
}
