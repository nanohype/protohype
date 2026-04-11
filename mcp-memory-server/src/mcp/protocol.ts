/**
 * MCP (Model Context Protocol) JSON-RPC 2.0 types.
 * Transport: HTTP POST — single endpoint, synchronous response.
 * Spec: https://spec.modelcontextprotocol.io/specification/
 */

// ── JSON-RPC 2.0 base types ─────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result: T;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<T = unknown> =
  | JsonRpcSuccessResponse<T>
  | JsonRpcErrorResponse;

// Standard JSON-RPC error codes
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// ── MCP Tool types ──────────────────────────────────────────────────────────

export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, McpPropertySchema>;
  required?: string[];
}

export interface McpPropertySchema {
  type: string;
  description?: string;
  items?: McpPropertySchema;
  properties?: Record<string, McpPropertySchema>;
  required?: string[];
  enum?: unknown[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

export interface McpToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export type McpContent = McpTextContent;

// ── MCP method names ────────────────────────────────────────────────────────

export const MCP_METHODS = {
  INITIALIZE: "initialize",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
  PING: "ping",
} as const;

export type McpMethod = (typeof MCP_METHODS)[keyof typeof MCP_METHODS];

// ── Initialize response ─────────────────────────────────────────────────────

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

// ── Helper constructors ─────────────────────────────────────────────────────

export function successResponse<T>(
  id: string | number,
  result: T
): JsonRpcSuccessResponse<T> {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export function toolResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], isError };
}
