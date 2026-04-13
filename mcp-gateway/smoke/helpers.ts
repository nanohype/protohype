/**
 * Smoke test helpers.
 *
 * Reads API_ENDPOINT and API_TOKEN from env. The Makefile `smoke` target
 * queries CloudFormation + Secrets Manager and injects both before invoking
 * Jest, so in normal operation you don't set these by hand.
 *
 * DASHBOARD_URL is optional — only used by infrastructure smoke tests.
 */

import { randomUUID } from 'crypto';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Run \`make smoke\` from the project root, or source the env manually:\n` +
      `  export API_ENDPOINT=$(aws cloudformation describe-stacks --stack-name McpGateway ` +
      `--query "Stacks[0].Outputs[?ExportName=='McpGateway-ApiEndpoint'].OutputValue" --output text)\n` +
      `  export API_TOKEN=$(aws secretsmanager get-secret-value ` +
      `--secret-id /mcp-gateway/gateway-bearer-token --query SecretString --output text)`,
    );
  }
  return v;
}

export const API_ENDPOINT = requireEnv('API_ENDPOINT').replace(/\/$/, '');
export const API_TOKEN = requireEnv('API_TOKEN');
export const DASHBOARD_URL = process.env.DASHBOARD_URL?.replace(/\/$/, '');

export interface HttpResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  raw: string;
}

export type AuthOption = boolean | string; // true=default token, false=no auth, string=custom token

function authHeader(auth: AuthOption | undefined): Record<string, string> {
  if (auth === false) return {};
  const token = typeof auth === 'string' ? auth : API_TOKEN;
  return { Authorization: `Bearer ${token}` };
}

async function request<T = unknown>(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: AuthOption; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeader(opts.auth),
    ...opts.headers,
  };
  const body = opts.rawBody !== undefined ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const res = await fetch(`${API_ENDPOINT}${path}`, { method, headers, body });
  const raw = await res.text();
  let parsed: unknown = raw;
  try { parsed = JSON.parse(raw); } catch { /* leave as string */ }
  return { status: res.status, body: parsed as T, headers: res.headers, raw };
}

export const get = <T = unknown>(path: string, opts?: { auth?: AuthOption; headers?: Record<string, string> }) =>
  request<T>('GET', path, opts);

export const post = <T = unknown>(path: string, body: unknown, opts?: { auth?: AuthOption; headers?: Record<string, string>; rawBody?: string }) =>
  request<T>('POST', path, { ...opts, body });

export const postRaw = <T = unknown>(path: string, rawBody: string, opts?: { auth?: AuthOption; headers?: Record<string, string> }) =>
  request<T>('POST', path, { ...opts, rawBody });

// MCP JSON-RPC envelope helpers

export interface McpSuccess {
  jsonrpc: '2.0';
  id?: string | number;
  result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
}

export interface McpError {
  jsonrpc: '2.0';
  id?: string | number;
  error: { code: number; message: string; data?: unknown };
}

export type McpResponse = McpSuccess | McpError;

export function mcpEnvelope(method: string, params?: unknown, id: string | number = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

export async function mcpCall<T = unknown>(
  path: string,
  method: string,
  params?: unknown,
  opts: { auth?: AuthOption; id?: string | number } = {},
): Promise<HttpResponse<McpResponse>> {
  return post<McpResponse>(path, mcpEnvelope(method, params, opts.id ?? 1), { auth: opts.auth });
}

export function isMcpSuccess(r: McpResponse): r is McpSuccess {
  return 'result' in r && r.result !== undefined;
}

export function isMcpError(r: McpResponse): r is McpError {
  return 'error' in r && r.error !== undefined;
}

export function parseMcpResultText<T = unknown>(r: McpResponse): T {
  if (!isMcpSuccess(r)) {
    throw new Error(`MCP response was not a success: ${JSON.stringify(r)}`);
  }
  const text = r.result.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`MCP result has no text content: ${JSON.stringify(r.result)}`);
  }
  return JSON.parse(text) as T;
}

// Unique IDs for isolation between concurrent smoke runs

export function testAgentId(): string {
  return `smoketest-agent-${randomUUID().slice(0, 8)}`;
}

export function testSessionId(): string {
  return `smoketest-session-${randomUUID().slice(0, 8)}`;
}
