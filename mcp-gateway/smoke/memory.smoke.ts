import { mcpCall, parseMcpResultText, isMcpError, isMcpSuccess, testAgentId, type McpResponse } from './helpers';

interface StoredMemory {
  memoryId: string;
  text: string;
  summary?: string;
  tags?: string[];
  createdAt: number;
  metadata?: Record<string, unknown>;
}

interface StoreResult { memoryId: string; agentId: string; stored: boolean; embeddingDimensions: number; }
interface QueryResult { query: string; results: Array<StoredMemory & { similarity: number }>; count: number; }
interface ListResult { agentId: string; memories: StoredMemory[]; count: number; }
interface DeleteResult { deleted: boolean; agentId: string; memoryId: string; }

const AGENT_ID = testAgentId();
const createdMemoryIds: string[] = [];

async function store(text: string, extras: Record<string, unknown> = {}): Promise<StoreResult> {
  const res = await mcpCall('/memory', 'tools/call', {
    name: 'memory_store',
    arguments: { agentId: AGENT_ID, text, ...extras },
  });
  expect(res.status).toBe(200);
  if (!isMcpSuccess(res.body)) {
    throw new Error(`memory_store failed: ${JSON.stringify(res.body)}`);
  }
  const result = parseMcpResultText<StoreResult>(res.body);
  createdMemoryIds.push(result.memoryId);
  return result;
}

async function list(extras: Record<string, unknown> = {}): Promise<ListResult> {
  const res = await mcpCall('/memory', 'tools/call', {
    name: 'memory_list',
    arguments: { agentId: AGENT_ID, ...extras },
  });
  expect(res.status).toBe(200);
  if (!isMcpSuccess(res.body)) {
    throw new Error(`memory_list failed: ${JSON.stringify(res.body)}`);
  }
  return parseMcpResultText<ListResult>(res.body);
}

async function query(query: string, extras: Record<string, unknown> = {}): Promise<QueryResult> {
  const res = await mcpCall('/memory', 'tools/call', {
    name: 'memory_query',
    arguments: { agentId: AGENT_ID, query, ...extras },
  });
  expect(res.status).toBe(200);
  if (!isMcpSuccess(res.body)) {
    throw new Error(`memory_query failed: ${JSON.stringify(res.body)}`);
  }
  return parseMcpResultText<QueryResult>(res.body);
}

async function del(memoryId: string): Promise<DeleteResult> {
  const res = await mcpCall('/memory', 'tools/call', {
    name: 'memory_delete',
    arguments: { agentId: AGENT_ID, memoryId },
  });
  expect(res.status).toBe(200);
  if (!isMcpSuccess(res.body)) {
    throw new Error(`memory_delete failed: ${JSON.stringify(res.body)}`);
  }
  return parseMcpResultText<DeleteResult>(res.body);
}

// MCP spec: tools/list returns { tools } directly on `result` (not inside
// the tools/call content-envelope), so assert the raw shape here.
type ToolsListResult = { jsonrpc: '2.0'; id?: string | number; result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> } };

describe('memory — protocol discovery', () => {
  test('tools/list returns 4 tools with expected names and required fields', async () => {
    const res = await mcpCall('/memory', 'tools/list');
    expect(res.status).toBe(200);
    const { tools } = (res.body as unknown as ToolsListResult).result;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['memory_delete', 'memory_list', 'memory_query', 'memory_store']);
    expect(byName.memory_store.inputSchema.required).toEqual(['agentId', 'text']);
    expect(byName.memory_query.inputSchema.required).toEqual(['agentId', 'query']);
    expect(byName.memory_list.inputSchema.required).toEqual(['agentId']);
    expect(byName.memory_delete.inputSchema.required).toEqual(['agentId', 'memoryId']);
  });

  test('initialize returns protocolVersion + capabilities + serverInfo on result', async () => {
    const res = await mcpCall('/memory', 'initialize');
    expect(res.status).toBe(200);
    const result = (res.body as McpResponse & { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string; version: string } } }).result;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toBeDefined();
    expect(result.serverInfo.name).toBe('mcp-gateway-memory');
    expect(typeof result.serverInfo.version).toBe('string');
  });
});

describe('memory — CRUD cycle', () => {
  let primaryMemoryId: string;

  test('memory_store with just agentId + text succeeds', async () => {
    const result = await store('The smoke test is the tallest building on earth.');
    expect(result.stored).toBe(true);
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.memoryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.embeddingDimensions).toBe(384);
    primaryMemoryId = result.memoryId;
  });

  test('memory_store with all optional fields succeeds', async () => {
    const now = Math.floor(Date.now() / 1000);
    const result = await store('An additional memory with tags.', {
      summary: 'tagged smoke test memory',
      tags: ['smoke', 'tagged'],
      ttl: 60, // 1 minute
      metadata: { source: 'smoke-suite', nonce: 42 },
    });
    expect(result.stored).toBe(true);
    // Can't directly verify TTL via MCP, but store completed without error.
    void now;
  });

  test('memory_list includes stored memory and exposes `text` field', async () => {
    const { memories } = await list();
    const primary = memories.find((m) => m.memoryId === primaryMemoryId);
    expect(primary).toBeDefined();
    expect(primary?.text).toContain('tallest building');
    // Should be `text`, not `content` — proves the schema alignment.
    expect((primary as unknown as { content?: string }).content).toBeUndefined();
  });

  test('memory_query finds semantically similar memory', async () => {
    const result = await query('What is the largest structure?');
    expect(result.count).toBeGreaterThan(0);
    const matched = result.results.find((r) => r.memoryId === primaryMemoryId);
    expect(matched).toBeDefined();
    expect(matched?.similarity).toBeGreaterThan(0.2);
  });

  test('memory_query with threshold filters low-similarity results', async () => {
    const result = await query('totally unrelated quantum mechanics physics', { threshold: 0.99 });
    expect(result.count).toBe(0);
  });

  test('memory_list with tag filter returns only tagged memories', async () => {
    const { memories } = await list({ tags: ['smoke'] });
    for (const m of memories) {
      expect(m.tags).toContain('smoke');
    }
  });

  test('memory_delete removes the memory', async () => {
    const result = await del(primaryMemoryId);
    expect(result.deleted).toBe(true);
    expect(result.memoryId).toBe(primaryMemoryId);
    // Remove from tracking so afterAll doesn't re-attempt
    const i = createdMemoryIds.indexOf(primaryMemoryId);
    if (i >= 0) createdMemoryIds.splice(i, 1);
  });

  test('memory_list after delete no longer includes the deleted memory', async () => {
    const { memories } = await list();
    expect(memories.find((m) => m.memoryId === primaryMemoryId)).toBeUndefined();
  });
});

describe('memory — validation errors', () => {
  async function callAndExpectError(tool: string, args: Record<string, unknown>, messageMatch: RegExp) {
    const res = await mcpCall('/memory', 'tools/call', { name: tool, arguments: args });
    expect(res.status).toBe(200);
    expect(isMcpError(res.body)).toBe(true);
    if (isMcpError(res.body)) {
      expect(res.body.error.message).toMatch(messageMatch);
    }
  }

  test('memory_store without agentId → error', () => callAndExpectError('memory_store', { text: 'x' }, /agentId is required/));
  test('memory_store without text → error', () => callAndExpectError('memory_store', { agentId: AGENT_ID }, /text is required/));
  test('memory_query without agentId → error', () => callAndExpectError('memory_query', { query: 'x' }, /agentId is required/));
  test('memory_query without query → error', () => callAndExpectError('memory_query', { agentId: AGENT_ID }, /query is required/));
  test('memory_delete without memoryId → error', () => callAndExpectError('memory_delete', { agentId: AGENT_ID }, /memoryId is required/));

  test('unknown tool name → MCP error', async () => {
    const res = await mcpCall('/memory', 'tools/call', { name: 'does_not_exist', arguments: {} });
    expect(isMcpError(res.body)).toBe(true);
    if (isMcpError(res.body)) {
      expect(res.body.error.message).toMatch(/Unknown tool/);
    }
  });
});

afterAll(async () => {
  // Clean up any memories that weren't explicitly deleted.
  if (createdMemoryIds.length === 0) return;
  await Promise.all(createdMemoryIds.map((id) => del(id).catch(() => { /* best-effort */ })));
});
