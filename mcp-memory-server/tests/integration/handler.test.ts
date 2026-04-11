/**
 * Integration tests: full MCP handler dispatch
 * Tests the JSON-RPC 2.0 protocol layer end-to-end.
 */

import { patchEnv } from "../setup/dynamodb-local";
patchEnv();

import { handler } from "../../src/handler";
import type { APIGatewayProxyEvent, Context } from "aws-lambda";

function makeEvent(body: object): APIGatewayProxyEvent {
  return {
    httpMethod: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    isBase64Encoded: false,
    path: "/memory",
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    multiValueHeaders: {},
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent["requestContext"],
    resource: "",
  };
}

const fakeContext = {} as Context;

describe("MCP handler — protocol layer", () => {
  it("responds to ping", async () => {
    const event = makeEvent({ jsonrpc: "2.0", id: 1, method: "ping" });
    const res = await handler(event, fakeContext) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toEqual({});
  });

  it("responds to initialize", async () => {
    const event = makeEvent({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    const res = await handler(event, fakeContext) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo.name).toBe("mcp-memory-server");
  });

  it("lists tools", async () => {
    const event = makeEvent({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const res = await handler(event, fakeContext) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    const toolNames = body.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("memory_store");
    expect(toolNames).toContain("memory_query");
    expect(toolNames).toContain("memory_list");
    expect(toolNames).toContain("memory_delete");
  });

  it("returns parse error for invalid JSON", async () => {
    const event: APIGatewayProxyEvent = {
      ...makeEvent({}),
      body: "not json {{",
    };
    const res = await handler(event, fakeContext) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32700);
  });

  it("returns method not found for unknown method", async () => {
    const event = makeEvent({ jsonrpc: "2.0", id: 5, method: "unknown/method" });
    const res = await handler(event, fakeContext) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32601);
  });

  it("executes memory_store via tools/call", async () => {
    const event = makeEvent({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "memory_store",
        arguments: {
          agentId: "handler-test-agent",
          content: "MCP protocol test memory",
        },
      },
    });
    const res = await handler(event, fakeContext) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.content[0].type).toBe("text");
    const stored = JSON.parse(body.result.content[0].text);
    expect(stored.memoryId).toBeTruthy();
  });

  it("handles CORS preflight", async () => {
    const event: APIGatewayProxyEvent = { ...makeEvent({}), httpMethod: "OPTIONS" };
    const res = await handler(event, fakeContext) as { statusCode: number };
    expect(res.statusCode).toBe(204);
  });
});
