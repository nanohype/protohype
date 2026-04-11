/**
 * Integration tests: memory_delete operation
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { patchEnv, createTestClient, TEST_TABLE } from "../setup/dynamodb-local";
patchEnv();

import { storeMemory } from "../../src/operations/store";
import { deleteMemory } from "../../src/operations/delete";

const ddb = createTestClient();
const AGENT = "agent-delete-tests";

describe("memory_delete", () => {
  it("deletes an existing memory", async () => {
    const stored = await storeMemory({ agentId: AGENT, content: "To be deleted" });
    const { memoryId } = JSON.parse(stored.content[0].text);

    const result = await deleteMemory({ agentId: AGENT, memoryId });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted).toBe(true);
    expect(parsed.memoryId).toBe(memoryId);

    // Verify it's gone from DynamoDB
    const { Item } = await ddb.send(
      new GetCommand({ TableName: TEST_TABLE, Key: { agentId: AGENT, memoryId } })
    );
    expect(Item).toBeUndefined();
  });

  it("returns not-found when memory does not exist", async () => {
    const result = await deleteMemory({
      agentId: AGENT,
      memoryId: "01HZZ000000000000000000000", // valid ULID that doesn't exist
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted).toBe(false);
  });

  it("cannot delete a memory belonging to a different agent", async () => {
    const stored = await storeMemory({ agentId: "agent-A", content: "Agent A's secret" });
    const { memoryId } = JSON.parse(stored.content[0].text);

    // Try to delete as agent-B
    const result = await deleteMemory({ agentId: "agent-B", memoryId });
    expect(result.isError).toBe(true);

    // Original item still exists
    const { Item } = await ddb.send(
      new GetCommand({ TableName: TEST_TABLE, Key: { agentId: "agent-A", memoryId } })
    );
    expect(Item).toBeDefined();
  });

  it("returns error for missing agentId", async () => {
    const result = await deleteMemory({ agentId: "", memoryId: "anything" });
    expect(result.isError).toBe(true);
  });

  it("returns error for missing memoryId", async () => {
    const result = await deleteMemory({ agentId: AGENT, memoryId: "" });
    expect(result.isError).toBe(true);
  });
});
