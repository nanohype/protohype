/**
 * Stripe MCP server.
 * Read-only tools for inspecting customers, payments, subscriptions, invoices.
 * Write tools: create customer.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Stripe from 'stripe';
import { z } from 'zod';

export function createStripeServer(creds: { secretKey: string }): McpServer {
  const stripe = new Stripe(creds.secretKey);
  const server = new McpServer({ name: 'mcp-stripe', version: '0.1.0' });

  server.tool(
    'stripe_get_balance',
    'Get the current Stripe account balance.',
    {},
    async () => {
      const balance = await stripe.balance.retrieve();
      return { content: [{ type: 'text', text: JSON.stringify(balance, null, 2) }] };
    }
  );

  // ─── Customers ────────────────────────────────────────────────────────────

  server.tool(
    'stripe_list_customers',
    'List Stripe customers. Optionally search by email.',
    {
      limit: z.number().int().min(1).max(100).default(20).describe('Max customers to return'),
      email: z.string().email().optional().describe('Filter by email address'),
      startingAfter: z.string().optional().describe('Pagination cursor (customer ID)'),
    },
    async ({ limit, email, startingAfter }) => {
      const customers = await stripe.customers.list({ limit, email, starting_after: startingAfter });
      return { content: [{ type: 'text', text: JSON.stringify(customers, null, 2) }] };
    }
  );

  server.tool(
    'stripe_get_customer',
    'Get details of a specific Stripe customer.',
    {
      customerId: z.string().describe('Stripe customer ID (cus_...)'),
    },
    async ({ customerId }) => {
      const customer = await stripe.customers.retrieve(customerId);
      return { content: [{ type: 'text', text: JSON.stringify(customer, null, 2) }] };
    }
  );

  server.tool(
    'stripe_create_customer',
    'Create a new Stripe customer.',
    {
      email: z.string().email().describe('Customer email address'),
      name: z.string().optional().describe('Customer full name'),
      phone: z.string().optional().describe('Phone number'),
      description: z.string().optional().describe('Arbitrary description'),
      metadata: z.record(z.string()).optional().describe('Key/value metadata'),
    },
    async ({ email, name, phone, description, metadata }) => {
      const customer = await stripe.customers.create({ email, name, phone, description, metadata });
      return { content: [{ type: 'text', text: JSON.stringify(customer, null, 2) }] };
    }
  );

  // ─── Payments ─────────────────────────────────────────────────────────────

  server.tool(
    'stripe_list_payments',
    'List Stripe payment intents.',
    {
      limit: z.number().int().min(1).max(100).default(20).describe('Max payments to return'),
      customerId: z.string().optional().describe('Filter by customer ID'),
      startingAfter: z.string().optional().describe('Pagination cursor (payment intent ID)'),
    },
    async ({ limit, customerId, startingAfter }) => {
      const params: Stripe.PaymentIntentListParams = { limit, starting_after: startingAfter };
      if (customerId) params.customer = customerId;
      const payments = await stripe.paymentIntents.list(params);
      return { content: [{ type: 'text', text: JSON.stringify(payments, null, 2) }] };
    }
  );

  server.tool(
    'stripe_get_payment',
    'Get details of a specific Stripe payment intent.',
    {
      paymentIntentId: z.string().describe('Payment intent ID (pi_...)'),
    },
    async ({ paymentIntentId }) => {
      const payment = await stripe.paymentIntents.retrieve(paymentIntentId);
      return { content: [{ type: 'text', text: JSON.stringify(payment, null, 2) }] };
    }
  );

  // ─── Subscriptions ────────────────────────────────────────────────────────

  server.tool(
    'stripe_list_subscriptions',
    'List Stripe subscriptions.',
    {
      limit: z.number().int().min(1).max(100).default(20).describe('Max subscriptions'),
      customerId: z.string().optional().describe('Filter by customer ID'),
      status: z
        .enum(['active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'trialing', 'all'])
        .default('active')
        .describe('Filter by subscription status'),
      startingAfter: z.string().optional().describe('Pagination cursor'),
    },
    async ({ limit, customerId, status, startingAfter }) => {
      const params: Stripe.SubscriptionListParams = {
        limit,
        status: status === 'all' ? undefined : status,
        starting_after: startingAfter,
      };
      if (customerId) params.customer = customerId;
      const subs = await stripe.subscriptions.list(params);
      return { content: [{ type: 'text', text: JSON.stringify(subs, null, 2) }] };
    }
  );

  server.tool(
    'stripe_get_subscription',
    'Get details of a specific Stripe subscription.',
    {
      subscriptionId: z.string().describe('Subscription ID (sub_...)'),
    },
    async ({ subscriptionId }) => {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      return { content: [{ type: 'text', text: JSON.stringify(sub, null, 2) }] };
    }
  );

  // ─── Invoices ─────────────────────────────────────────────────────────────

  server.tool(
    'stripe_list_invoices',
    'List Stripe invoices.',
    {
      limit: z.number().int().min(1).max(100).default(20).describe('Max invoices'),
      customerId: z.string().optional().describe('Filter by customer ID'),
      subscriptionId: z.string().optional().describe('Filter by subscription ID'),
      status: z
        .enum(['draft', 'open', 'paid', 'uncollectible', 'void'])
        .optional()
        .describe('Filter by invoice status'),
      startingAfter: z.string().optional().describe('Pagination cursor'),
    },
    async ({ limit, customerId, subscriptionId, status, startingAfter }) => {
      const params: Stripe.InvoiceListParams = { limit, starting_after: startingAfter };
      if (customerId) params.customer = customerId;
      if (subscriptionId) params.subscription = subscriptionId;
      if (status) params.status = status;
      const invoices = await stripe.invoices.list(params);
      return { content: [{ type: 'text', text: JSON.stringify(invoices, null, 2) }] };
    }
  );

  server.tool(
    'stripe_get_invoice',
    'Get details of a specific Stripe invoice.',
    {
      invoiceId: z.string().describe('Invoice ID (in_...)'),
    },
    async ({ invoiceId }) => {
      const invoice = await stripe.invoices.retrieve(invoiceId);
      return { content: [{ type: 'text', text: JSON.stringify(invoice, null, 2) }] };
    }
  );

  return server;
}
