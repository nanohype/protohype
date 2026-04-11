/**
 * Integration tests: memory_store operation
 * Runs against DynamoDB Local (managed by @shelf/jest-dynamodb preset).
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { patchEnv, createTestClient, TEST_TABLE } from "../setup/dynamodb-local";

// Patch env before importing source modules
patchEnv();

// Re-import after env patch so db/client picks up the test endpoint
import { storeMemory } from "../../src/operations/store";

const ddb = createTestClient();

describe("memory_store", () => {
  it("stores a memory and returns a memoryId", async () => {
    const result = await storeMemory({
      agentId: "agent-001",
      content: "The capital of France is Paris.",
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.memoryId).toBeTruthy();
    expect(parsed.agentId).toBe("agent-001");
    expect(parsed.createdAt).toBeTruthy();
  });

  it("persists the item to DynamoDB", async () => {
    const result = await storeMemory({
      agentId: "agent-002",
      content: "TypeScript is a typed superset of JavaScript.",
      metadata: { source: "test" },
      tags: ["typescript", "javascript"],
    });

    const parsed = JSON.parse(result.content[0].text);
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: TEST_TABLE,
        Key: { agentId: "agent-002", memoryId: parsed.memoryId },
      })
    );

    expect(Item).toBeDefined();
    expect(Item!.content).toBe("TypeScript is a typed superset of JavaScript.");
    expect(Item!.tags).toEqual(["typescript", "javascript"]);
    expect(JSON.parse(Item!.metadata)).toEqual({ source: "test" });
  });

  it("stores with TTL when ttlSeconds is provided", async () => {
    const before = Math.floor(Date.now() / 1000);

    const result = await storeMemory({
      agentId: "agent-003",
      content: "This memory expires soon.",
      ttlSeconds: 3600,
    });

    const parsed = JSON.parse(result.content[0].text);
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: TEST_TABLE,
        Key: { agentId: "agent-003", memoryId: parsed.memoryId },
      })
    );

    expect(Item!.expiresAt).toBeGreaterThanOrEqual(before + 3600);
    expect(Item!.expiresAt).toBeLessThanOrEqual(before + 3601);
  });

  it("returns an error for missing content", async () => {
    const result = await storeMemory({
      agentId: "agent-004",
      content: "",
    });

    expect(result.isError).toBe(true);
  });

  it("returns an error for missing agentId", async () => {
    const result = await storeMemory({
      agentId: "",
      content: "some content",
    });

    expect(result.isError).toBe(true);
  });
});
