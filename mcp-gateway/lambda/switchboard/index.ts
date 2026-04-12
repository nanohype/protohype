/**
 * MCP Switchboard Lambda
 *
 * Routes MCP protocol requests to third-party services:
 *   - HubSpot CRM
 *   - Google Drive
 *   - Google Calendar
 *   - Google Analytics
 *   - Google Custom Search
 *   - Stripe
 *
 * URL: /mcp/{service}
 * Body: MCP JSON-RPC { method: "tools/call", params: { name, arguments } }
 * Credentials: fetched from Secrets Manager per service (cached 5min in Lambda memory)
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getGoogleAccessToken, isServiceAccount, GoogleServiceAccount } from './google-auth';

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-west-2' });

interface McpToolCallRequest {
  method: 'tools/call' | 'tools/list' | 'initialize' | 'resources/list';
  params?: { name?: string; arguments?: Record<string, unknown>; [key: string]: unknown };
  id?: string | number; jsonrpc?: string;
}

interface McpToolCallResponse {
  jsonrpc: string; id?: string | number;
  result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}

type ServiceName = 'hubspot' | 'google-drive' | 'google-calendar' | 'google-analytics' | 'google-custom-search' | 'stripe';

/**
 * Credential shapes accepted by the switchboard.
 *   - HubSpot, Stripe: `{apiKey}` (or `{accessToken}` for HubSpot private apps)
 *   - Google Custom Search: `{apiKey, cx}`
 *   - Google Drive / Calendar / Analytics: `GoogleServiceAccount` (the JSON
 *     Google IAM emits when you download a service account key)
 */
interface ServiceCredentials {
  apiKey?: string;
  accessToken?: string;  // HubSpot private app tokens
  cx?: string;           // Google Custom Search engine ID
  [key: string]: unknown; // allow service account JSON fields without enumerating them
}

const GOOGLE_SCOPES: Partial<Record<ServiceName, string>> = {
  'google-drive': 'https://www.googleapis.com/auth/drive',
  'google-calendar': 'https://www.googleapis.com/auth/calendar',
  'google-analytics': 'https://www.googleapis.com/auth/analytics.readonly',
};

/**
 * Resolve a bearer token for a Google-OAuth-bearing service by minting a
 * short-lived access token from the stored service account JSON. Throws
 * with an actionable message if the secret is missing or malformed.
 */
async function resolveGoogleBearer(service: ServiceName, creds: ServiceCredentials): Promise<string> {
  const scope = GOOGLE_SCOPES[service];
  if (!scope) throw new Error(`No Google scope configured for service: ${service}`);
  if (!isServiceAccount(creds)) {
    throw new Error(
      `Invalid credentials for ${service}: expected a Google service account JSON ` +
      `(fields: type, private_key, client_email). Populate the secret with the JSON file ` +
      `from GCP → IAM → Service Accounts → Keys. See README "Configure Service Credentials".`
    );
  }
  return getGoogleAccessToken(creds as unknown as GoogleServiceAccount, scope);
}

// Credential cache (5-min TTL)
const credentialCache = new Map<ServiceName, { creds: ServiceCredentials; expiry: number }>();
const CRED_CACHE_TTL_MS = 5 * 60 * 1000;

async function getCredentials(service: ServiceName): Promise<ServiceCredentials> {
  const cached = credentialCache.get(service);
  if (cached && Date.now() < cached.expiry) return cached.creds;
  const envKey = `SECRET_ARN_${service.toUpperCase().replace(/-/g, '_')}`;
  const secretArn = process.env[envKey];
  if (!secretArn) throw new Error(`No secret ARN configured for service: ${service}`);
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) throw new Error(`Secret for ${service} has no string value`);
  const creds = JSON.parse(result.SecretString) as ServiceCredentials;
  credentialCache.set(service, { creds, expiry: Date.now() + CRED_CACHE_TTL_MS });
  return creds;
}

// Tool definitions per service
const SERVICE_TOOLS: Record<ServiceName, Array<{ name: string; description: string; inputSchema: object }>> = {
  hubspot: [
    { name: 'search_contacts', description: 'Search HubSpot contacts by name or email', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
    { name: 'create_contact', description: 'Create a new HubSpot contact', inputSchema: { type: 'object', properties: { email: { type: 'string' }, firstname: { type: 'string' }, lastname: { type: 'string' } }, required: ['email'] } },
    { name: 'create_deal', description: 'Create a new deal in HubSpot', inputSchema: { type: 'object', properties: { dealname: { type: 'string' }, amount: { type: 'number' }, stage: { type: 'string' } }, required: ['dealname'] } },
    { name: 'get_contact', description: 'Get HubSpot contact by ID', inputSchema: { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] } },
  ],
  'google-drive': [
    { name: 'list_files', description: 'List files in Google Drive', inputSchema: { type: 'object', properties: { query: { type: 'string' }, pageSize: { type: 'number' } } } },
    { name: 'get_file', description: 'Get file metadata from Google Drive', inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] } },
    { name: 'read_file', description: 'Read file content from Google Drive', inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] } },
    { name: 'create_file', description: 'Create a file in Google Drive', inputSchema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string' } }, required: ['name', 'content'] } },
  ],
  'google-calendar': [
    { name: 'list_events', description: 'List calendar events', inputSchema: { type: 'object', properties: { calendarId: { type: 'string' }, timeMin: { type: 'string' }, timeMax: { type: 'string' } } } },
    { name: 'create_event', description: 'Create a calendar event', inputSchema: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, description: { type: 'string' } }, required: ['summary', 'start', 'end'] } },
    { name: 'delete_event', description: 'Delete a calendar event', inputSchema: { type: 'object', properties: { calendarId: { type: 'string' }, eventId: { type: 'string' } }, required: ['eventId'] } },
  ],
  'google-analytics': [
    { name: 'run_report', description: 'Run a Google Analytics 4 report', inputSchema: { type: 'object', properties: { propertyId: { type: 'string' }, dimensions: { type: 'array', items: { type: 'string' } }, metrics: { type: 'array', items: { type: 'string' } }, dateRanges: { type: 'array' } }, required: ['propertyId', 'metrics'] } },
    { name: 'get_realtime', description: 'Get realtime data from GA4', inputSchema: { type: 'object', properties: { propertyId: { type: 'string' }, metrics: { type: 'array', items: { type: 'string' } } }, required: ['propertyId'] } },
  ],
  'google-custom-search': [
    { name: 'search', description: 'Perform a Google Custom Search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, num: { type: 'number' }, start: { type: 'number' } }, required: ['query'] } },
  ],
  stripe: [
    { name: 'list_customers', description: 'List Stripe customers', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, email: { type: 'string' } } } },
    { name: 'get_customer', description: 'Get a Stripe customer by ID', inputSchema: { type: 'object', properties: { customerId: { type: 'string' } }, required: ['customerId'] } },
    { name: 'list_subscriptions', description: 'List active Stripe subscriptions', inputSchema: { type: 'object', properties: { customerId: { type: 'string' }, status: { type: 'string' } } } },
    { name: 'get_invoice', description: 'Get a Stripe invoice', inputSchema: { type: 'object', properties: { invoiceId: { type: 'string' } }, required: ['invoiceId'] } },
  ],
};

// Service routers
async function routeHubSpot(tool: string, args: Record<string, unknown>, creds: ServiceCredentials): Promise<unknown> {
  const base = 'https://api.hubapi.com';
  const h = { 'Authorization': `Bearer ${creds.accessToken ?? creds.apiKey}`, 'Content-Type': 'application/json' };
  switch (tool) {
    case 'search_contacts': return (await fetch(`${base}/crm/v3/objects/contacts/search`, { method: 'POST', headers: h, body: JSON.stringify({ filterGroups: [{ filters: [{ value: args.query, propertyName: 'email', operator: 'CONTAINS_TOKEN' }] }], limit: args.limit ?? 10 }) })).json();
    case 'create_contact': return (await fetch(`${base}/crm/v3/objects/contacts`, { method: 'POST', headers: h, body: JSON.stringify({ properties: args }) })).json();
    case 'get_contact': return (await fetch(`${base}/crm/v3/objects/contacts/${args.contactId}`, { headers: h })).json();
    case 'create_deal': return (await fetch(`${base}/crm/v3/objects/deals`, { method: 'POST', headers: h, body: JSON.stringify({ properties: args }) })).json();
    default: throw new Error(`Unknown HubSpot tool: ${tool}`);
  }
}

async function routeGoogleDrive(tool: string, args: Record<string, unknown>, creds: ServiceCredentials): Promise<unknown> {
  const base = 'https://www.googleapis.com/drive/v3';
  const token = await resolveGoogleBearer('google-drive', creds);
  const h = { 'Authorization': `Bearer ${token}` };
  switch (tool) {
    case 'list_files': return (await fetch(`${base}/files?${new URLSearchParams({ pageSize: String(args.pageSize ?? 20), fields: 'files(id,name,mimeType,modifiedTime)', ...(args.query ? { q: String(args.query) } : {}) })}`, { headers: h })).json();
    case 'get_file': return (await fetch(`${base}/files/${args.fileId}?fields=*`, { headers: h })).json();
    case 'read_file': return { content: await (await fetch(`${base}/files/${args.fileId}?alt=media`, { headers: h })).text() };
    case 'create_file': {
      const meta = { name: args.name, mimeType: args.mimeType ?? 'text/plain' };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      form.append('file', new Blob([String(args.content)], { type: String(meta.mimeType) }));
      return (await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: h, body: form })).json();
    }
    default: throw new Error(`Unknown Google Drive tool: ${tool}`);
  }
}

async function routeGoogleCalendar(tool: string, args: Record<string, unknown>, creds: ServiceCredentials): Promise<unknown> {
  const calId = String(args.calendarId ?? 'primary');
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}`;
  const token = await resolveGoogleBearer('google-calendar', creds);
  const h = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  switch (tool) {
    case 'list_events': return (await fetch(`${base}/events?${new URLSearchParams({ maxResults: '20', singleEvents: 'true', orderBy: 'startTime', ...(args.timeMin ? { timeMin: String(args.timeMin) } : {}), ...(args.timeMax ? { timeMax: String(args.timeMax) } : {}) })}`, { headers: h })).json();
    case 'create_event': return (await fetch(`${base}/events`, { method: 'POST', headers: h, body: JSON.stringify({ summary: args.summary, description: args.description, start: { dateTime: args.start, timeZone: 'UTC' }, end: { dateTime: args.end, timeZone: 'UTC' } }) })).json();
    case 'delete_event': await fetch(`${base}/events/${args.eventId}`, { method: 'DELETE', headers: h }); return { deleted: true };
    default: throw new Error(`Unknown Google Calendar tool: ${tool}`);
  }
}

async function routeGoogleAnalytics(tool: string, args: Record<string, unknown>, creds: ServiceCredentials): Promise<unknown> {
  const token = await resolveGoogleBearer('google-analytics', creds);
  const h = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (tool === 'run_report') {
    return (await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${args.propertyId}:runReport`, { method: 'POST', headers: h, body: JSON.stringify({ dimensions: ((args.dimensions as string[]) ?? []).map(d => ({ name: d })), metrics: (args.metrics as string[]).map(m => ({ name: m })), dateRanges: args.dateRanges ?? [{ startDate: '30daysAgo', endDate: 'today' }] }) })).json();
  }
  if (tool === 'get_realtime') {
    return (await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${args.propertyId}:runRealtimeReport`, { method: 'POST', headers: h, body: JSON.stringify({ metrics: (args.metrics as string[]).map(m => ({ name: m })) }) })).json();
  }
  throw new Error(`Unknown Google Analytics tool: ${tool}`);
}

async function routeGoogleCustomSearch(tool: string, args: Record<string, unknown>, creds: ServiceCredentials): Promise<unknown> {
  if (tool !== 'search') throw new Error(`Unknown Custom Search tool: ${tool}`);
  return (await fetch(`https://www.googleapis.com/customsearch/v1?${new URLSearchParams({ key: creds.apiKey ?? '', cx: creds.cx ?? '', q: String(args.query), num: String(args.num ?? 10), ...(args.start ? { start: String(args.start) } : {}) })}`)).json();
}

async function routeStripe(tool: string, args: Record<string, unknown>, creds: ServiceCredentials): Promise<unknown> {
  const base = 'https://api.stripe.com/v1';
  const h = { 'Authorization': `Bearer ${creds.apiKey}` };
  switch (tool) {
    case 'list_customers': return (await fetch(`${base}/customers?${new URLSearchParams({ limit: String(args.limit ?? 10), ...(args.email ? { email: String(args.email) } : {}) })}`, { headers: h })).json();
    case 'get_customer': return (await fetch(`${base}/customers/${args.customerId}`, { headers: h })).json();
    case 'list_subscriptions': return (await fetch(`${base}/subscriptions?${new URLSearchParams({ limit: '10', ...(args.customerId ? { customer: String(args.customerId) } : {}), ...(args.status ? { status: String(args.status) } : {}) })}`, { headers: h })).json();
    case 'get_invoice': return (await fetch(`${base}/invoices/${args.invoiceId}`, { headers: h })).json();
    default: throw new Error(`Unknown Stripe tool: ${tool}`);
  }
}

const SERVICE_ROUTERS: Record<ServiceName, (tool: string, args: Record<string, unknown>, creds: ServiceCredentials) => Promise<unknown>> = {
  hubspot: routeHubSpot, 'google-drive': routeGoogleDrive, 'google-calendar': routeGoogleCalendar,
  'google-analytics': routeGoogleAnalytics, 'google-custom-search': routeGoogleCustomSearch,
  stripe: routeStripe,
};

const VALID_SERVICES = new Set<string>(Object.keys(SERVICE_ROUTERS));
function isValidService(s: string): s is ServiceName { return VALID_SERVICES.has(s); }

function mcpSuccess(id: string | number | undefined, data: unknown): McpToolCallResponse {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } };
}
function mcpError(id: string | number | undefined, code: number, message: string, data?: unknown): McpToolCallResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const pathParams = event.pathParameters ?? {};
  const service = pathParams['service'] ?? '';

  if (!isValidService(service)) {
    return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Unknown service: ${service}. Valid: ${[...VALID_SERVICES].join(', ')}` }) };
  }

  let body: McpToolCallRequest;
  try { body = JSON.parse(event.body ?? '{}') as McpToolCallRequest; }
  catch { return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const mcpId = body.id;
  const headers = { 'Content-Type': 'application/json' };

  try {
    if (body.method === 'tools/list' || body.method === 'initialize') {
      return { statusCode: 200, headers, body: JSON.stringify(mcpSuccess(mcpId, { tools: SERVICE_TOOLS[service] })) };
    }
    if (body.method !== 'tools/call') {
      return { statusCode: 200, headers, body: JSON.stringify(mcpError(mcpId, -32601, `Method not supported: ${body.method}`)) };
    }
    const toolName = body.params?.name;
    const toolArgs = (body.params?.arguments ?? {}) as Record<string, unknown>;
    if (!toolName) {
      return { statusCode: 200, headers, body: JSON.stringify(mcpError(mcpId, -32602, 'Missing params.name')) };
    }
    const validTools = SERVICE_TOOLS[service].map((t) => t.name);
    if (!validTools.includes(toolName)) {
      return { statusCode: 200, headers, body: JSON.stringify(mcpError(mcpId, -32602, `Unknown tool '${toolName}' for service '${service}'. Available: ${validTools.join(', ')}`)) };
    }
    const creds = await getCredentials(service);
    const result = await SERVICE_ROUTERS[service](toolName, toolArgs, creds);
    return { statusCode: 200, headers, body: JSON.stringify(mcpSuccess(mcpId, result)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Switchboard error [${service}]:`, message); // Never log creds
    return { statusCode: 200, headers, body: JSON.stringify(mcpError(mcpId, -32603, message)) };
  }
};
