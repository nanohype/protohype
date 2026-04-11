import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { ddb, TABLE_NAME } from "../db/client";
import { computeEmbeddings } from "../embeddings/client";
import { toolResult, McpToolResult } from "../mcp/protocol";

export interface StoreArgs {
  agentId: string;
  content: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  ttlSeconds?: number;
}

export interface MemoryItem {
  agentId: string;
  memoryId: string;
  content: string;
  embedding: string; // JSON-serialized float32 array
  metadata: string; // JSON-serialized object
  tags: string[];
  createdAt: string; // ISO-8601
  expiresAt?: number; // Unix epoch seconds (DynamoDB TTL)
}

export async function storeMemory(args: StoreArgs): Promise<McpToolResult> {
  const { agentId, content, metadata = {}, tags = [], ttlSeconds } = args;

  if (!agentId || typeof agentId !== "string") {
    return toolResult("Invalid agentId", true);
  }
  if (!content || typeof content !== "string") {
    return toolResult("content is required", true);
  }

  const memoryId = ulid();
  const createdAt = new Date().toISOString();

  // Compute embedding (non-blocking failure — store without embedding)
  let embeddingJson = "[]";
  try {
    const embeddings = await computeEmbeddings([content]);
    embeddingJson = JSON.stringify(embeddings[0] ?? []);
  } catch (err) {
    console.warn("Embedding computation failed, storing without embedding:", err);
  }

  const item: MemoryItem = {
    agentId,
    memoryId,
    content,
    embedding: embeddingJson,
    metadata: JSON.stringify(metadata),
    tags,
    createdAt,
    ...(ttlSeconds != null
      ? { expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds }
      : {}),
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
    })
  );

  return toolResult(
    JSON.stringify({
      memoryId,
      agentId,
      createdAt,
      hasEmbedding: embeddingJson !== "[]",
    })
  );
}
