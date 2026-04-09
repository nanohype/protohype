import { describe, it, expect } from "vitest";
import { bootstrapVectorStore } from "./vectors.js";
import type { Config } from "../config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    llmProvider: "anthropic",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 3,
    vectorProvider: "memory",
    crawlIntervalMinutes: 60,
    crawlTimeoutMs: 30_000,
    userAgent: "test",
    slackAlertChannel: "#test",
    significanceThreshold: 0.3,
    port: 3000,
    nodeEnv: "test",
    logLevel: "error",
    ...overrides,
  } as Config;
}

describe("MemoryVectorStore", () => {
  it("upserts and searches documents", async () => {
    const store = bootstrapVectorStore(makeConfig());
    await store.upsert([
      { id: "1", content: "hello", embedding: [1, 0, 0], metadata: { src: "a" } },
      { id: "2", content: "world", embedding: [0, 1, 0], metadata: { src: "b" } },
    ]);

    const results = await store.search([1, 0, 0], 1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
    expect(results[0].score).toBeCloseTo(1.0);
  });

  it("filters by metadata", async () => {
    const store = bootstrapVectorStore(makeConfig());
    await store.upsert([
      { id: "1", content: "a", embedding: [1, 0, 0], metadata: { src: "alpha" } },
      { id: "2", content: "b", embedding: [1, 0, 0], metadata: { src: "beta" } },
    ]);

    const results = await store.search([1, 0, 0], 10, { src: "beta" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("2");
  });

  it("deleteByMetadata removes matching documents", async () => {
    const store = bootstrapVectorStore(makeConfig());
    await store.upsert([
      { id: "1", content: "a", embedding: [1, 0, 0], metadata: { sourceId: "x" } },
      { id: "2", content: "b", embedding: [0, 1, 0], metadata: { sourceId: "x" } },
      { id: "3", content: "c", embedding: [0, 0, 1], metadata: { sourceId: "y" } },
    ]);

    const deleted = await store.deleteByMetadata({ sourceId: "x" });
    expect(deleted).toBe(2);
    expect(await store.count()).toBe(1);
  });

  it("delete removes by ID", async () => {
    const store = bootstrapVectorStore(makeConfig());
    await store.upsert([
      { id: "1", content: "a", embedding: [1, 0, 0], metadata: {} },
      { id: "2", content: "b", embedding: [0, 1, 0], metadata: {} },
    ]);

    await store.delete(["1"]);
    expect(await store.count()).toBe(1);
  });
});
