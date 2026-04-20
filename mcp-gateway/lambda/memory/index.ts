/**
 * MCP Memory Server Lambda
 * Tools: memory_store, memory_query, memory_list, memory_delete
 * Storage: DynamoDB (agentId PK, memoryId SK)
 * Embeddings: invokes sentence-transformers container Lambda
 */
import { DynamoDBClient, QueryCommand, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-west-2' });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION ?? 'us-west-2' });
const TABLE = process.env.MEMORY_TABLE_NAME ?? 'mcp-gateway-memory';
const EMBEDDING_FN = process.env.EMBEDDING_FUNCTION_NAME ?? '';

interface McpRequest { jsonrpc?: string; method: string; params?: { name?: string; arguments?: Record<string, unknown> }; id?: string | number; }
interface McpResponse { jsonrpc: string; id?: string | number; result?: unknown; error?: { code: number; message: string }; }
interface MemoryItem { agentId: string; memoryId: string; text: string; summary?: string; tags?: string[]; embedding: number[]; createdAt: number; updatedAt: number; expiresAt?: number; metadata?: Record<string, unknown>; }

async function getEmbedding(text: string): Promise<number[]> {
  const result = await lambdaClient.send(new InvokeCommand({ FunctionName: EMBEDDING_FN, Payload: Buffer.from(JSON.stringify({ text })), InvocationType: 'RequestResponse' }));
  if (!result.Payload) throw new Error('No payload from embedding Lambda');
  const parsed = JSON.parse(Buffer.from(result.Payload).toString('utf-8')) as { embedding: number[]; error?: string };
  if (parsed.error) throw new Error(`Embedding error: ${parsed.error}`);
  if (!Array.isArray(parsed.embedding)) throw new Error('Invalid embedding response');
  return parsed.embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; normA += a[i]! * a[i]!; normB += b[i]! * b[i]!; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function storeMemory(item: MemoryItem): Promise<void> {
  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      agentId: { S: item.agentId }, memoryId: { S: item.memoryId }, text: { S: item.text },
      ...(item.summary ? { summary: { S: item.summary } } : {}),
      ...(item.tags?.length ? { tags: { SS: item.tags } } : {}),
      embedding: { S: JSON.stringify(item.embedding) },
      createdAt: { N: String(item.createdAt) }, updatedAt: { N: String(item.updatedAt) },
      ...(item.expiresAt ? { expiresAt: { N: String(item.expiresAt) } } : {}),
      ...(item.metadata ? { metadata: { S: JSON.stringify(item.metadata) } } : {}),
    },
  }));
}

async function queryMemoriesForAgent(agentId: string, limit = 100): Promise<MemoryItem[]> {
  const result = await dynamo.send(new QueryCommand({
    TableName: TABLE, IndexName: 'agentId-createdAt-index',
    KeyConditionExpression: 'agentId = :agentId',
    ExpressionAttributeValues: { ':agentId': { S: agentId } },
    ScanIndexForward: false, Limit: limit,
  }));
  return (result.Items ?? []).map((item) => ({
    agentId: item['agentId']?.S ?? '', memoryId: item['memoryId']?.S ?? '', text: item['text']?.S ?? '',
    summary: item['summary']?.S, tags: item['tags']?.SS,
    embedding: JSON.parse(item['embedding']?.S ?? '[]') as number[],
    createdAt: parseInt(item['createdAt']?.N ?? '0'), updatedAt: parseInt(item['updatedAt']?.N ?? '0'),
    expiresAt: item['expiresAt'] ? parseInt(item['expiresAt'].N ?? '0') : undefined,
    metadata: item['metadata'] ? JSON.parse(item['metadata'].S ?? '{}') as Record<string, unknown> : undefined,
  }));
}

async function toolMemoryStore(args: Record<string, unknown>): Promise<unknown> {
  const agentId = String(args.agentId ?? '');
  const text = String(args.text ?? '');
  if (!agentId) throw new Error('agentId is required');
  if (!text) throw new Error('text is required');
  const embedding = await getEmbedding(text);
  const now = Date.now();
  const memoryId = randomUUID();
  const ttl = typeof args.ttl === 'number' ? args.ttl : undefined; // seconds
  await storeMemory({
    agentId, memoryId, text,
    summary: args.summary ? String(args.summary) : undefined,
    tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
    embedding,
    createdAt: Math.floor(now / 1000),
    updatedAt: Math.floor(now / 1000),
    expiresAt: ttl ? Math.floor(now / 1000) + ttl : undefined,
    metadata: args.metadata as Record<string, unknown> | undefined,
  });
  return { memoryId, agentId, stored: true, embeddingDimensions: embedding.length };
}

async function toolMemoryQuery(args: Record<string, unknown>): Promise<unknown> {
  const agentId = String(args.agentId ?? ''); const query = String(args.query ?? '');
  if (!agentId) throw new Error('agentId is required'); if (!query) throw new Error('query is required');
  const topK = typeof args.topK === 'number' ? args.topK : 5;
  const threshold = typeof args.threshold === 'number' ? args.threshold : 0.0;
  const [queryEmbedding, memories] = await Promise.all([getEmbedding(query), queryMemoriesForAgent(agentId, 500)]);
  const ranked = memories
    .map((m) => ({ memoryId: m.memoryId, agentId: m.agentId, text: m.text, summary: m.summary, tags: m.tags, similarity: cosineSimilarity(queryEmbedding, m.embedding), createdAt: m.createdAt, metadata: m.metadata }))
    .filter((m) => m.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
  return { query, results: ranked, count: ranked.length };
}

async function toolMemoryList(args: Record<string, unknown>): Promise<unknown> {
  const agentId = String(args.agentId ?? '');
  if (!agentId) throw new Error('agentId is required');
  const limit = typeof args.limit === 'number' ? Math.min(args.limit, 100) : 20;
  const filterTags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
  const memories = await queryMemoriesForAgent(agentId, limit * 2);
  const filtered = filterTags ? memories.filter((m) => filterTags.some((t) => m.tags?.includes(t))) : memories;
  return { agentId, memories: filtered.slice(0, limit).map((m) => ({ memoryId: m.memoryId, text: m.text, summary: m.summary, tags: m.tags, createdAt: m.createdAt, metadata: m.metadata })), count: filtered.length };
}

async function toolMemoryDelete(args: Record<string, unknown>): Promise<unknown> {
  const agentId = String(args.agentId ?? ''); const memoryId = String(args.memoryId ?? '');
  if (!agentId) throw new Error('agentId is required'); if (!memoryId) throw new Error('memoryId is required');
  await dynamo.send(new DeleteItemCommand({ TableName: TABLE, Key: { agentId: { S: agentId }, memoryId: { S: memoryId } } }));
  return { deleted: true, agentId, memoryId };
}

const TOOLS = [
  { name: 'memory_store', description: 'Store a new memory for an agent with semantic embedding.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, text: { type: 'string' }, summary: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, ttl: { type: 'number', description: 'TTL in seconds' }, metadata: { type: 'object' } }, required: ['agentId', 'text'] } },
  { name: 'memory_query', description: 'Semantic similarity search across an agent\'s stored memories.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, query: { type: 'string' }, topK: { type: 'number' }, threshold: { type: 'number' } }, required: ['agentId', 'query'] } },
  { name: 'memory_list', description: 'List stored memories for an agent, optionally filtered by tags.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, limit: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['agentId'] } },
  { name: 'memory_delete', description: 'Delete a specific memory by ID.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, memoryId: { type: 'string' } }, required: ['agentId', 'memoryId'] } },
];

const TOOL_MAP: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  memory_store: toolMemoryStore, memory_query: toolMemoryQuery, memory_list: toolMemoryList, memory_delete: toolMemoryDelete,
};

// Raw result for initialize / tools/list / etc. — the MCP spec places the
// method-specific payload (protocolVersion, tools array, …) directly on
// `result`. Only tools/call wraps its payload in a `content` array.
function mcpOk(id: string | number | undefined, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}
function mcpCallOk(id: string | number | undefined, data: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } };
}
function mcpErr(id: string | number | undefined, code: number, message: string): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const headers = { 'Content-Type': 'application/json' };

  // Streamable HTTP transport opens a GET on the base path to upgrade to an
  // SSE channel during initialize. We don't stream — return 200 with no body
  // so the client falls through to plain POST request/response.
  if (event.requestContext.http.method === 'GET') {
    return { statusCode: 200, headers, body: '' };
  }

  let body: McpRequest;
  try { body = JSON.parse(event.body ?? '{}') as McpRequest; }
  catch { return { statusCode: 400, headers, body: JSON.stringify(mcpErr(undefined, -32700, 'Parse error')) }; }
  const id = body.id;
  try {
    if (body.method === 'initialize') {
      return { statusCode: 200, headers, body: JSON.stringify(mcpOk(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-gateway-memory', version: '1.0.0' },
      })) };
    }
    if (body.method === 'tools/list') {
      return { statusCode: 200, headers, body: JSON.stringify(mcpOk(id, { tools: TOOLS })) };
    }
    if (body.method === 'notifications/initialized' || !body.method) {
      // Notifications have no id and MUST NOT receive a response body per
      // JSON-RPC 2.0. Acknowledge at the HTTP layer and return empty.
      return { statusCode: 200, headers, body: '' };
    }
    if (body.method !== 'tools/call') {
      return { statusCode: 200, headers, body: JSON.stringify(mcpErr(id, -32601, `Method not found: ${body.method}`)) };
    }
    const toolName = body.params?.name;
    const toolArgs = (body.params?.arguments ?? {}) as Record<string, unknown>;
    if (!toolName || !TOOL_MAP[toolName]) {
      return { statusCode: 200, headers, body: JSON.stringify(mcpErr(id, -32602, `Unknown tool: ${toolName}`)) };
    }
    const result = await TOOL_MAP[toolName]!(toolArgs);
    return { statusCode: 200, headers, body: JSON.stringify(mcpCallOk(id, result)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Memory server error:', message);
    return { statusCode: 200, headers, body: JSON.stringify(mcpErr(id, -32603, message)) };
  }
};
