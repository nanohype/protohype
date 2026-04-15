/**
 * HubSpot MCP server.
 * Tools: contacts (list, get, create, update), deals (list, get, create, update),
 *        companies (list), notes (create).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@hubspot/api-client';
import { z } from 'zod';
import { logger } from '../logger.js';

export function createHubSpotServer(credentials: { apiKey: string }): McpServer {
  const client = new Client({ accessToken: credentials.apiKey });
  const server = new McpServer({ name: 'mcp-hubspot', version: '0.1.0' });

  // ─── Contacts ─────────────────────────────────────────────────────────────

  server.registerTool(
    'hubspot_list_contacts',
    {
      description: 'List HubSpot contacts. Optionally filter by email or name query.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe('Max results to return'),
        query: z.string().optional().describe('Search query to filter contacts by name or email'),
        after: z.string().optional().describe('Pagination cursor from previous response'),
      },
    },
    async ({ limit, query, after }) => {
      try {
        if (query) {
          const result = await client.crm.contacts.searchApi.doSearch({
            filterGroups: [],
            query,
            limit,
            after: after ?? '0',
            properties: ['firstname', 'lastname', 'email', 'company', 'phone'],
            sorts: [],
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }
        const result = await client.crm.contacts.basicApi.getPage(
          limit,
          after,
          ['firstname', 'lastname', 'email', 'company', 'phone']
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        logger.error('hubspot_list_contacts failed', { err: String(err) });
        throw err;
      }
    }
  );

  server.registerTool(
    'hubspot_get_contact',
    {
      description: 'Get a HubSpot contact by ID.',
      inputSchema: {
        contactId: z.string().describe('HubSpot contact ID'),
      },
    },
    async ({ contactId }) => {
      const result = await client.crm.contacts.basicApi.getById(contactId, [
        'firstname', 'lastname', 'email', 'company', 'phone', 'lifecyclestage',
      ]);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'hubspot_create_contact',
    {
      description: 'Create a new HubSpot contact.',
      inputSchema: {
        email: z.email().describe('Contact email address'),
        firstname: z.string().optional().describe('First name'),
        lastname: z.string().optional().describe('Last name'),
        company: z.string().optional().describe('Company name'),
        phone: z.string().optional().describe('Phone number'),
      },
    },
    async ({ email, firstname, lastname, company, phone }) => {
      const properties: Record<string, string> = { email };
      if (firstname) properties.firstname = firstname;
      if (lastname) properties.lastname = lastname;
      if (company) properties.company = company;
      if (phone) properties.phone = phone;
      const result = await client.crm.contacts.basicApi.create({ properties, associations: [] });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'hubspot_update_contact',
    {
      description: 'Update properties on an existing HubSpot contact.',
      inputSchema: {
        contactId: z.string().describe('HubSpot contact ID'),
        properties: z.record(z.string(), z.string()).describe('Key/value property pairs to update'),
      },
    },
    async ({ contactId, properties }) => {
      const result = await client.crm.contacts.basicApi.update(contactId, { properties });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── Deals ────────────────────────────────────────────────────────────────

  server.registerTool(
    'hubspot_list_deals',
    {
      description: 'List HubSpot deals. Optionally search by name.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
        query: z.string().optional().describe('Search query for deal name'),
        after: z.string().optional().describe('Pagination cursor'),
      },
    },
    async ({ limit, query, after }) => {
      if (query) {
        const result = await client.crm.deals.searchApi.doSearch({
          filterGroups: [],
          query,
          limit,
          after: after ?? '0',
          properties: ['dealname', 'amount', 'dealstage', 'closedate', 'pipeline'],
          sorts: [],
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      const result = await client.crm.deals.basicApi.getPage(
        limit,
        after,
        ['dealname', 'amount', 'dealstage', 'closedate', 'pipeline']
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'hubspot_get_deal',
    {
      description: 'Get a HubSpot deal by ID.',
      inputSchema: {
        dealId: z.string().describe('HubSpot deal ID'),
      },
    },
    async ({ dealId }) => {
      const result = await client.crm.deals.basicApi.getById(dealId, [
        'dealname', 'amount', 'dealstage', 'closedate', 'pipeline', 'hubspot_owner_id',
      ]);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'hubspot_create_deal',
    {
      description: 'Create a new HubSpot deal.',
      inputSchema: {
        dealname: z.string().describe('Name of the deal'),
        amount: z.string().optional().describe('Deal amount as string (e.g., "5000")'),
        dealstage: z.string().optional().describe('Deal stage ID'),
        pipeline: z.string().optional().describe('Pipeline ID'),
        closedate: z.string().optional().describe('Expected close date (ISO 8601)'),
      },
    },
    async ({ dealname, amount, dealstage, pipeline, closedate }) => {
      const properties: Record<string, string> = { dealname };
      if (amount) properties.amount = amount;
      if (dealstage) properties.dealstage = dealstage;
      if (pipeline) properties.pipeline = pipeline;
      if (closedate) properties.closedate = closedate;
      const result = await client.crm.deals.basicApi.create({ properties, associations: [] });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'hubspot_update_deal',
    {
      description: 'Update properties on an existing HubSpot deal.',
      inputSchema: {
        dealId: z.string().describe('HubSpot deal ID'),
        properties: z.record(z.string(), z.string()).describe('Key/value property pairs to update'),
      },
    },
    async ({ dealId, properties }) => {
      const result = await client.crm.deals.basicApi.update(dealId, { properties });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── Companies ────────────────────────────────────────────────────────────

  server.registerTool(
    'hubspot_list_companies',
    {
      description: 'List HubSpot companies. Optionally search by name.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
        query: z.string().optional().describe('Search query for company name or domain'),
        after: z.string().optional().describe('Pagination cursor'),
      },
    },
    async ({ limit, query, after }) => {
      if (query) {
        const result = await client.crm.companies.searchApi.doSearch({
          filterGroups: [],
          query,
          limit,
          after: after ?? '0',
          properties: ['name', 'domain', 'industry', 'numberofemployees', 'city'],
          sorts: [],
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      const result = await client.crm.companies.basicApi.getPage(
        limit,
        after,
        ['name', 'domain', 'industry', 'numberofemployees', 'city']
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── Notes ────────────────────────────────────────────────────────────────

  server.registerTool(
    'hubspot_create_note',
    {
      description: 'Create an activity note in HubSpot, optionally associated with a contact or deal.',
      inputSchema: {
        body: z.string().describe('Note content/body text'),
        contactId: z.string().optional().describe('Associate note with this contact ID'),
        dealId: z.string().optional().describe('Associate note with this deal ID'),
      },
    },
    async ({ body, contactId, dealId }) => {
      const associations: Array<{ to: { id: string }; types: Array<{ associationCategory: 'HUBSPOT_DEFINED'; associationTypeId: number }>; }> = [];
      if (contactId) {
        associations.push({
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
        });
      }
      if (dealId) {
        associations.push({
          to: { id: dealId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }],
        });
      }
      const result = await client.crm.objects.notes.basicApi.create({
        properties: {
          hs_note_body: body,
          hs_timestamp: new Date().toISOString(),
        },
        associations: associations as never,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}
