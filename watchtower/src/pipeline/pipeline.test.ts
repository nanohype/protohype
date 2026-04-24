import { describe, it, expect } from "vitest";
import { chunkText } from "./chunker.js";
import { createCorpusIndexer } from "./indexer.js";
import { createFakeEmbedder, createFakeVectorStore } from "./fake.js";
import { createLogger } from "../logger.js";
import type { RuleChange } from "../crawlers/types.js";

const silent = createLogger("error", "pipeline-test");

function sampleRuleChange(overrides: Partial<RuleChange> = {}): RuleChange {
  return {
    sourceId: "sec-edgar",
    contentHash: "abc123",
    title: "Proposed rule: enhanced disclosure",
    url: "https://www.sec.gov/news/release/proposed-1",
    publishedAt: "2026-04-20T10:00:00.000Z",
    summary: "Enhanced disclosure rules for broker-dealers",
    body:
      "Long body text. " + "Paragraph one with substantive content about rule changes. ".repeat(30),
    rawMetadata: {},
    ...overrides,
  };
}

describe("chunkText", () => {
  it("returns the whole text when shorter than chunk size", () => {
    const out = chunkText("hello world", { chunkSize: 100, overlap: 10 });
    expect(out).toEqual(["hello world"]);
  });

  it("splits long text into multiple chunks", () => {
    const text = "a".repeat(5000);
    const out = chunkText(text, { chunkSize: 1000, overlap: 0 });
    expect(out.length).toBeGreaterThanOrEqual(5);
  });

  it("drops empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("rejects invalid chunk sizes and overlaps", () => {
    expect(() => chunkText("x", { chunkSize: 0 })).toThrow();
    expect(() => chunkText("x", { chunkSize: 100, overlap: 100 })).toThrow();
  });
});

describe("createCorpusIndexer", () => {
  it("chunks → embeds → upserts each rule change", async () => {
    const embedder = createFakeEmbedder();
    const store = createFakeVectorStore();
    const indexer = createCorpusIndexer({ embedder, vectorStore: store, logger: silent });
    const result = await indexer.indexRuleChange(sampleRuleChange());
    expect(result.chunks).toBeGreaterThan(0);
    expect(store.rows).toHaveLength(result.chunks);
    expect(store.rows[0]!.sourceId).toBe("sec-edgar");
    expect(store.rows[0]!.ruleChangeId).toBe("abc123");
  });

  it("replaces prior chunks when the rule change is re-indexed (revised body)", async () => {
    const embedder = createFakeEmbedder();
    const store = createFakeVectorStore();
    const indexer = createCorpusIndexer({ embedder, vectorStore: store, logger: silent });

    const v1 = sampleRuleChange({ body: "old body content " + "x".repeat(2000) });
    await indexer.indexRuleChange(v1);
    const v1Count = store.rows.length;

    const v2 = sampleRuleChange({ body: "revised shorter body" });
    await indexer.indexRuleChange(v2);

    expect(await store.countByRuleChange("sec-edgar", "abc123")).toBeLessThanOrEqual(v1Count);
    expect(
      store.rows.every(
        (r) => r.content.includes("revised") || r.content === "revised shorter body",
      ),
    ).toBe(true);
  });

  it("handles empty bodies by falling back to summary then title", async () => {
    const embedder = createFakeEmbedder();
    const store = createFakeVectorStore();
    const indexer = createCorpusIndexer({ embedder, vectorStore: store, logger: silent });
    const result = await indexer.indexRuleChange(
      sampleRuleChange({ body: "", summary: "just a summary" }),
    );
    expect(result.chunks).toBe(1);
    expect(store.rows[0]!.content).toBe("just a summary");
  });

  it("writes stable deterministic row IDs", async () => {
    const embedder = createFakeEmbedder();
    const store = createFakeVectorStore();
    const indexer = createCorpusIndexer({ embedder, vectorStore: store, logger: silent });
    await indexer.indexRuleChange(sampleRuleChange());
    for (let i = 0; i < store.rows.length; i++) {
      expect(store.rows[i]!.id).toBe(`sec-edgar:abc123:${i}`);
    }
  });
});
