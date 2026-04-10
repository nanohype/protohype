/**
 * Tests for the HubSpot MCP server.
 * Mocks @hubspot/api-client — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHubSpotServer } from '../../src/servers/hubspot.js';

// ─── Mock HubSpot client ──────────────────────────────────────────────────────

const mockGetPage = vi.fn();
const mockGetById = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockSearch = vi.fn();

const mockClient = {
  crm: {
    contacts: {
      basicApi: { getPage: mockGetPage, getById: mockGetById, create: mockCreate, update: mockUpdate },
      searchApi: { doSearch: mockSearch },
    },
    deals: {
      basicApi: { getPage: mockGetPage, getById: mockGetById, create: mockCreate, update: mockUpdate },
      searchApi: { doSearch: mockSearch },
    },
    companies: {
      basicApi: { getPage: mockGetPage },
      searchApi: { doSearch: mockSearch },
    },
    objects: {
      notes: {
        basicApi: { create: mockCreate },
      },
    },
  },
};

vi.mock('@hubspot/api-client', () => ({
  Client: vi.fn().mockImplementation(() => mockClient),
}));

// ─── Helper ───────────────────────────────────────────────────────────────────

function getServer() {
  return createHubSpotServer({ apiKey: 'test-key' });
}

/** Simulate a tool call through the MCP server. */
async function callTool(server: ReturnType<typeof getServer>, name: string, args: Record<string, unknown>) {
  // Access internal tool handler via the server's registered tools
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Map<string, { handler: (args: unknown) => Promise<unknown> }>;
  const tool = tools?.get(name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler(args);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createHubSpotServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a server with name mcp-hubspot', () => {
    const server = getServer();
    // McpServer stores the server info
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any)._serverInfo?.name).toBe('mcp-hubspot');
  });
});

describe('hubspot tools — list_contacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPage.mockResolvedValue({ results: [{ id: '1', properties: { email: 'a@b.com' } }] });
  });

  it('calls basicApi.getPage without a query', async () => {
    const server = getServer();
    await callTool(server, 'hubspot_list_contacts', { limit: 10 });
    expect(mockGetPage).toHaveBeenCalledWith(10, undefined, expect.any(Array));
  });

  it('calls searchApi.doSearch when query is provided', async () => {
    mockSearch.mockResolvedValue({ results: [] });
    const server = getServer();
    await callTool(server, 'hubspot_list_contacts', { limit: 5, query: 'alice' });
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'alice', limit: 5 }));
  });
});

describe('hubspot tools — get_contact', () => {
  it('calls basicApi.getById with contactId', async () => {
    mockGetById.mockResolvedValue({ id: '42', properties: {} });
    const server = getServer();
    await callTool(server, 'hubspot_get_contact', { contactId: '42' });
    expect(mockGetById).toHaveBeenCalledWith('42', expect.any(Array));
  });
});

describe('hubspot tools — create_contact', () => {
  it('creates contact with email and optional fields', async () => {
    mockCreate.mockResolvedValue({ id: '99' });
    const server = getServer();
    await callTool(server, 'hubspot_create_contact', {
      email: 'new@example.com',
      firstname: 'Alice',
      lastname: 'Smith',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ email: 'new@example.com', firstname: 'Alice' }),
      })
    );
  });
});

describe('hubspot tools — create_note', () => {
  it('creates a note with body', async () => {
    mockCreate.mockResolvedValue({ id: '55' });
    const server = getServer();
    await callTool(server, 'hubspot_create_note', { body: 'Called prospect', contactId: '12' });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ hs_note_body: 'Called prospect' }),
      })
    );
  });
});
