/**
 * Integration tests: memory_query operation
 * Embedding-free mode (EMBEDDING_FUNCTION_ARN="") — verifies DynamoDB I/O
 * and result structure. Semantic ranking tests live in unit tests with mocked embeddings.
 */

import { patchEnv, TEST_TABLE } from "../setup/dynamodb-local";
patchEnv();

import { storeMemory } from "../../src/operations/store";
import { queryMemories } from "../../src/operations/query";

const AGENT = "agent-query-tests";

beforeAll(async () => {
  // Seed memories
  await storeMemory({ agentId: AGENT, content: "Paris is the capital of France.", tags: ["geography"] });
  await storeMemory({ agentId: AGENT, content: "Berlin is the capital of Germany.", tags: ["geography"] });
  await storeMemory({ agentId: AGENT, content: "TypeScript adds types to JavaScript.", tags: ["programming"] });
  await storeMemory({ agentId: AGENT, content: "AWS Lambda runs functions on demand.", tags: ["cloud"] });
});

describe("memory_query", () => {
  it("returns results for a matching query (no embeddings)", async () => {
    const result = await queryMemories({ agentId: AGENT, query: "European capitals" });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.results)).toBe(true);
    // Without embeddings all scores are 0, so all items are returned up to topK
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it("respects topK limit", async () => {
    const result = await queryMemories({ agentId: AGENT, query: "anything", topK: 2 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results.length).toBeLessThanOrEqual(2);
  });

  it("filters by tags", async () => {
    const result = await queryMemories({
      agentId: AGENT,
      query: "anything",
      tags: ["geography"],
      topK: 10,
    });

    const parsed = JSON.parse(result.content[0].text);
    for (const r of parsed.results) {
      expect(r.tags).toContain("geography");
    }
  });

  it("returns empty results for an unknown agent", async () => {
    const result = await queryMemories({ agentId: "nonexistent-agent-xyz", query: "test" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toHaveLength(0);
  });

  it("each result has required fields", async () => {
    const result = await queryMemories({ agentId: AGENT, query: "test" });
    const parsed = JSON.parse(result.content[0].text);

    for (const r of parsed.results) {
      expect(r).toHaveProperty("memoryId");
      expect(r).toHaveProperty("content");
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("createdAt");
      expect(r).toHaveProperty("tags");
    }
  });

  it("caps topK at 20", async () => {
    const result = await queryMemories({ agentId: AGENT, query: "test", topK: 999 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results.length).toBeLessThanOrEqual(20);
  });
});
