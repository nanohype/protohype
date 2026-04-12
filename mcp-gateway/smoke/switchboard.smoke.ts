import { mcpCall, post, postRaw, parseMcpResultText, isMcpSuccess, isMcpError } from './helpers';

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: object;
}

const SERVICES: Array<{ name: string; tools: string[] }> = [
  { name: 'hubspot', tools: ['search_contacts', 'create_contact', 'create_deal', 'get_contact'] },
  { name: 'google-drive', tools: ['list_files', 'get_file', 'read_file', 'create_file'] },
  { name: 'google-calendar', tools: ['list_events', 'create_event', 'delete_event'] },
  { name: 'google-analytics', tools: ['run_report', 'get_realtime'] },
  { name: 'google-custom-search', tools: ['search'] },
  { name: 'stripe', tools: ['list_customers', 'get_customer', 'list_subscriptions', 'get_invoice'] },
];

describe('switchboard — tools/list per service', () => {
  for (const { name, tools: expectedTools } of SERVICES) {
    test(`${name} exposes ${expectedTools.length} tools`, async () => {
      const res = await mcpCall(`/mcp/${name}`, 'tools/list');
      expect(res.status).toBe(200);
      expect(isMcpSuccess(res.body)).toBe(true);
      const { tools } = parseMcpResultText<{ tools: ToolSpec[] }>(res.body);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...expectedTools].sort());
      for (const tool of tools) {
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.inputSchema).toBe('object');
      }
    });
  }
});

describe('switchboard — routing + protocol errors', () => {
  test('unknown service → 404', async () => {
    const res = await mcpCall('/mcp/unknown-service', 'tools/list');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining('Unknown service') });
  });

  test('tools/call with unknown tool name → MCP error -32602', async () => {
    const res = await mcpCall('/mcp/hubspot', 'tools/call', { name: 'does_not_exist', arguments: {} });
    expect(res.status).toBe(200);
    expect(isMcpError(res.body)).toBe(true);
    if (isMcpError(res.body)) {
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toMatch(/Unknown tool/);
    }
  });

  test('tools/call missing params.name → MCP error -32602', async () => {
    const res = await mcpCall('/mcp/hubspot', 'tools/call', { arguments: {} });
    expect(res.status).toBe(200);
    expect(isMcpError(res.body)).toBe(true);
    if (isMcpError(res.body)) {
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toBe('Missing params.name');
    }
  });

  test('unsupported method → MCP error -32601', async () => {
    const res = await mcpCall('/mcp/hubspot', 'resources/list');
    expect(res.status).toBe(200);
    expect(isMcpError(res.body)).toBe(true);
    if (isMcpError(res.body)) {
      expect(res.body.error.code).toBe(-32601);
    }
  });

  test('malformed JSON body → 400', async () => {
    const res = await postRaw('/mcp/hubspot', '{not-valid-json');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid JSON body' });
  });

  test('initialize method returns the same tools as tools/list', async () => {
    const res = await mcpCall('/mcp/stripe', 'initialize');
    expect(res.status).toBe(200);
    const { tools } = parseMcpResultText<{ tools: ToolSpec[] }>(res.body);
    expect(tools.length).toBeGreaterThan(0);
  });
});
