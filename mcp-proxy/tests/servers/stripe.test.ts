/**
 * Tests for the Stripe MCP server.
 * Mocks the Stripe SDK — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStripeServer } from '../../src/servers/stripe.js';

// ─── Mock Stripe ──────────────────────────────────────────────────────────────

const mockBalance = { retrieve: vi.fn() };
const mockCustomers = { list: vi.fn(), retrieve: vi.fn(), create: vi.fn() };
const mockPaymentIntents = { list: vi.fn(), retrieve: vi.fn() };
const mockSubscriptions = { list: vi.fn(), retrieve: vi.fn() };
const mockInvoices = { list: vi.fn(), retrieve: vi.fn() };

vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    balance: mockBalance,
    customers: mockCustomers,
    paymentIntents: mockPaymentIntents,
    subscriptions: mockSubscriptions,
    invoices: mockInvoices,
  })),
}));

// ─── Helper ───────────────────────────────────────────────────────────────────

function getServer() {
  return createStripeServer({ secretKey: 'sk_test_xxx' });
}

async function callTool(server: ReturnType<typeof getServer>, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Map<string, { handler: (args: unknown) => Promise<unknown> }>;
  const tool = tools?.get(name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool.handler(args);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createStripeServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a server named mcp-stripe', () => {
    const server = getServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any)._serverInfo?.name).toBe('mcp-stripe');
  });
});

describe('stripe_get_balance', () => {
  it('calls balance.retrieve', async () => {
    mockBalance.retrieve.mockResolvedValue({ available: [], pending: [] });
    const server = getServer();
    await callTool(server, 'stripe_get_balance', {});
    expect(mockBalance.retrieve).toHaveBeenCalledOnce();
  });
});

describe('stripe_list_customers', () => {
  it('calls customers.list with default limit', async () => {
    mockCustomers.list.mockResolvedValue({ data: [] });
    const server = getServer();
    await callTool(server, 'stripe_list_customers', { limit: 20 });
    expect(mockCustomers.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it('passes email filter when provided', async () => {
    mockCustomers.list.mockResolvedValue({ data: [] });
    const server = getServer();
    await callTool(server, 'stripe_list_customers', { limit: 10, email: 'test@example.com' });
    expect(mockCustomers.list).toHaveBeenCalledWith(expect.objectContaining({ email: 'test@example.com' }));
  });
});

describe('stripe_create_customer', () => {
  it('creates a customer with email and name', async () => {
    mockCustomers.create.mockResolvedValue({ id: 'cus_123', email: 'new@example.com' });
    const server = getServer();
    await callTool(server, 'stripe_create_customer', { email: 'new@example.com', name: 'Alice' });
    expect(mockCustomers.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@example.com', name: 'Alice' })
    );
  });
});

describe('stripe_list_subscriptions', () => {
  it('filters by status=active by default', async () => {
    mockSubscriptions.list.mockResolvedValue({ data: [] });
    const server = getServer();
    await callTool(server, 'stripe_list_subscriptions', { limit: 20, status: 'active' });
    expect(mockSubscriptions.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' })
    );
  });

  it('passes undefined status when "all" is selected', async () => {
    mockSubscriptions.list.mockResolvedValue({ data: [] });
    const server = getServer();
    await callTool(server, 'stripe_list_subscriptions', { limit: 20, status: 'all' });
    expect(mockSubscriptions.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined })
    );
  });
});
