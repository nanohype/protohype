import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE_NAME } from "../db/client";
import { computeEmbeddings, cosineSimilarity } from "../embeddings/client";
import { toolResult, McpToolResult } from "../mcp/protocol";

export interface QueryArgs {
  agentId: string;
  query: string;
  topK?: number;
  minScore?: number;
  tags?: string[];
}

interface StoredItem {
  memoryId: string;
  content: string;
  embedding: string;
  metadata: string;
  tags?: string[];
  createdAt: string;
}

export async function queryMemories(args: QueryArgs): Promise<McpToolResult> {
  const {
    agentId,
    query,
    topK = 5,
    minScore = 0.0,
    tags = [],
  } = args;

  const k = Math.min(Math.max(1, topK), 20);

  // Compute embedding for the query text
  let queryEmbedding: number[] = [];
  try {
    const embeddings = await computeEmbeddings([query]);
    queryEmbedding = embeddings[0] ?? [];
  } catch (err) {
    console.warn("Could not compute query embedding, falling back to recency:", err);
  }

  // Load all memories for this agent (paginated)
  // For typical agent use-cases (<1000 items per agent) this is cost-effective.
  // At scale, migrate to OpenSearch Serverless or DynamoDB zero-ETL to OpenSearch.
  const items: StoredItem[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "agentId = :aid",
        ExpressionAttributeValues: { ":aid": agentId },
        ExclusiveStartKey: lastKey,
        Limit: 500,
      })
    );
    items.push(...((resp.Items as StoredItem[]) ?? []));
    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  // Tag filter
  const filtered =
    tags.length > 0
      ? items.filter((item) =>
          tags.every((t) => (item.tags ?? []).includes(t))
        )
      : items;

  // Score and rank
  const scored = filtered.map((item) => {
    let storedEmbedding: number[] = [];
    try {
      storedEmbedding = JSON.parse(item.embedding) as number[];
    } catch {
      // corrupt embedding — treat as no match
    }
    const score =
      queryEmbedding.length > 0 && storedEmbedding.length > 0
        ? cosineSimilarity(queryEmbedding, storedEmbedding)
        : 0;
    return { item, score };
  });

  const results = scored
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ item, score }) => ({
      memoryId: item.memoryId,
      content: item.content,
      score: Math.round(score * 10000) / 10000,
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

  return toolResult(JSON.stringify({ results, total: results.length }));
}
