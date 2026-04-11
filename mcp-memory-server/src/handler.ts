/**
 * MCP Memory Server — Lambda handler
 *
 * Exposes the MCP protocol over HTTP POST via API Gateway.
 * All four memory tools (store / query / list / delete) are dispatched here.
 *
 * Transport: Synchronous HTTP JSON (no SSE streaming).
 * Protocol:  JSON-RPC 2.0 (MCP 2024-11-05)
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";

import {
  JsonRpcRequest,
  McpToolCallParams,
  McpInitializeResult,
  MCP_METHODS,
  successResponse,
  errorResponse,
  toolResult,
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
} from "./mcp/protocol";

import { ALL_TOOLS } from "./mcp/tools";
import { storeMemory, StoreArgs } from "./operations/store";
import { queryMemories, QueryArgs } from "./operations/query";
import { listMemories, ListArgs } from "./operations/list";
import { deleteMemory, DeleteArgs } from "./operations/delete";

// ── CORS headers for browser-based MCP clients ──────────────────────────────
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

type LambdaEvent = APIGatewayProxyEventV2 | APIGatewayProxyEvent;
type LambdaResult = APIGatewayProxyResultV2 | APIGatewayProxyResult;

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handler(
  event: LambdaEvent,
  _context: Context
): Promise<LambdaResult> {
  const method = "requestContext" in event && "http" in event.requestContext
    ? event.requestContext.http.method
    : (event as APIGatewayProxyEvent).httpMethod;

  // CORS preflight
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  // Parse body
  let req: JsonRpcRequest;
  try {
    const raw = "isBase64Encoded" in event && event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString()
      : (event.body ?? "");

    req = JSON.parse(raw) as JsonRpcRequest;

    if (req.jsonrpc !== "2.0" || !req.method) {
      throw new Error("Invalid JSON-RPC request");
    }
  } catch (err) {
    return jsonResponse(400, errorResponse(null, RPC_PARSE_ERROR, "Parse error"));
  }

  try {
    const result = await dispatch(req);
    return jsonResponse(200, result);
  } catch (err) {
    console.error("Unhandled error in MCP handler:", err);
    return jsonResponse(
      500,
      errorResponse(
        req.id ?? null,
        RPC_INTERNAL_ERROR,
        err instanceof Error ? err.message : "Internal error"
      )
    );
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function dispatch(req: JsonRpcRequest) {
  switch (req.method) {
    case MCP_METHODS.PING:
      return successResponse(req.id, {});

    case MCP_METHODS.INITIALIZE: {
      const result: McpInitializeResult = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-memory-server", version: "0.1.0" },
      };
      return successResponse(req.id, result);
    }

    case MCP_METHODS.TOOLS_LIST:
      return successResponse(req.id, { tools: ALL_TOOLS });

    case MCP_METHODS.TOOLS_CALL: {
      const params = req.params as McpToolCallParams | undefined;

      if (!params?.name || typeof params.arguments !== "object") {
        return errorResponse(req.id, RPC_INVALID_PARAMS, "Invalid tool call params");
      }

      const toolRes = await callTool(params.name, params.arguments ?? {});
      return successResponse(req.id, toolRes);
    }

    default:
      return errorResponse(
        req.id,
        RPC_METHOD_NOT_FOUND,
        `Method not found: ${req.method}`
      );
  }
}

// ── Tool dispatcher ───────────────────────────────────────────────────────────

async function callTool(
  name: string,
  args: Record<string, unknown>
) {
  switch (name) {
    case "memory_store":
      return storeMemory(args as unknown as StoreArgs);

    case "memory_query":
      return queryMemories(args as unknown as QueryArgs);

    case "memory_list":
      return listMemories(args as unknown as ListArgs);

    case "memory_delete":
      return deleteMemory(args as unknown as DeleteArgs);

    default:
      return toolResult(`Unknown tool: ${name}`, true);
  }
}

// ── Response helper ───────────────────────────────────────────────────────────

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}
