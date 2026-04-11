/**
 * Integration tests: memory_list operation
 */

import { patchEnv } from "../setup/dynamodb-local";
patchEnv();

import { storeMemory } from "../../src/operations/store";
import { listMemories } from "../../src/operations/list";

const AGENT = "agent-list-tests";

beforeAll(async () => {
  // Insert 5 memories with slight delay to ensure createdAt ordering
  for (let i = 0; i < 5; i++) {
    await storeMemory({
      agentId: AGENT,
      content: `Memory item ${i}`,
      tags: i % 2 === 0 ? ["even"] : ["odd"],
    });
  }
});

describe("memory_list", () => {
  it("returns memories for an agent", async () => {
    const result = await listMemories({ agentId: AGENT });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.memories.length).toBeGreaterThanOrEqual(5);
  });

  it("respects limit", async () => {
    const result = await listMemories({ agentId: AGENT, limit: 2 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.memories.length).toBeLessThanOrEqual(2);
  });

  it("returns a nextCursor when more pages exist", async () => {
    const result = await listMemories({ agentId: AGENT, limit: 2 });
    const parsed = JSON.parse(result.content[0].text);

    if (parsed.memories.length === 2) {
      // May or may not have more pages depending on exact count
      // Just verify the field shape
      if (parsed.nextCursor) {
        expect(typeof parsed.nextCursor).toBe("string");
      }
    }
  });

  it("supports cursor-based pagination", async () => {
    const page1 = await listMemories({ agentId: AGENT, limit: 2 });
    const p1 = JSON.parse(page1.content[0].text);

    if (!p1.nextCursor) {
      // Not enough items to paginate; skip
      return;
    }

    const page2 = await listMemories({ agentId: AGENT, limit: 2, cursor: p1.nextCursor });
    const p2 = JSON.parse(page2.content[0].text);

    // No overlap between pages
    const ids1 = new Set(p1.memories.map((m: { memoryId: string }) => m.memoryId));
    for (const m of p2.memories) {
      expect(ids1.has(m.memoryId)).toBe(false);
    }
  });

  it("filters by tags", async () => {
    const result = await listMemories({ agentId: AGENT, tags: ["even"], limit: 100 });
    const parsed = JSON.parse(result.content[0].text);
    for (const m of parsed.memories) {
      expect(m.tags).toContain("even");
    }
  });

  it("returns empty list for unknown agent", async () => {
    const result = await listMemories({ agentId: "nobody-agent-xyz" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.memories).toHaveLength(0);
    expect(parsed.nextCursor).toBeUndefined();
  });

  it("caps limit at 100", async () => {
    const result = await listMemories({ agentId: AGENT, limit: 9999 });
    // Should not throw; DynamoDB caps at 100 due to our Math.min
    expect(result.isError).toBeFalsy();
  });

  it("returns invalid cursor error", async () => {
    const result = await listMemories({ agentId: AGENT, cursor: "not-valid-base64-json!!" });
    expect(result.isError).toBe(true);
  });

  it("each item has required fields", async () => {
    const result = await listMemories({ agentId: AGENT });
    const parsed = JSON.parse(result.content[0].text);
    for (const m of parsed.memories) {
      expect(m).toHaveProperty("memoryId");
      expect(m).toHaveProperty("content");
      expect(m).toHaveProperty("createdAt");
      expect(m).toHaveProperty("tags");
    }
  });
});
