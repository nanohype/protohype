import { describe, it, expect } from "vitest";
import { createCrawlHandler } from "./crawl.js";
import { createClassifyHandler } from "./classify.js";
import { createPublishHandler } from "./publish.js";
import { createCrawlerRegistry } from "../crawlers/registry.js";
import { createFakeDedup } from "../crawlers/dedup.js";
import { createFakeEmbedder, createFakeVectorStore } from "../pipeline/fake.js";
import { createCorpusIndexer } from "../pipeline/indexer.js";
import { createFakeClients } from "../clients/fake.js";
import { createFakeAudit } from "../audit/fake.js";
import { createClassifier } from "../classifier/classifier.js";
import { createFakeLlm } from "../classifier/fake.js";
import { createMemoDrafter } from "../memo/drafter.js";
import { createFakeMemoStorage } from "../memo/storage.js";
import { createApprovalGate } from "../publish/approval-gate.js";
import { createFakePublisher } from "../publish/fake.js";
import { createLogger } from "../logger.js";
import type { Crawler, RuleChange } from "../crawlers/types.js";
import type { ClientConfig } from "../clients/types.js";
import type { JobDefinition, QueueProvider } from "../consumer/types.js";

const silent = createLogger("error", "handlers-test");

function inMemoryQueue(): QueueProvider & { peek: () => readonly JobDefinition[] } {
  const jobs: JobDefinition[] = [];
  let id = 0;
  return {
    name: "in-memory",
    async init() {},
    async enqueue(name, data) {
      const jid = `mem-${++id}`;
      jobs.push({
        id: jid,
        name,
        data,
        attempts: 0,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
      });
      return jid;
    },
    async dequeue() {
      return jobs.shift() ?? null;
    },
    async acknowledge() {},
    async fail() {},
    async close() {},
    peek() {
      return jobs;
    },
  };
}

function ruleChange(overrides: Partial<RuleChange> = {}): RuleChange {
  return {
    sourceId: "sec-edgar",
    contentHash: "rc-1",
    title: "Proposed rule 15c3-1",
    url: "https://www.sec.gov/release",
    publishedAt: "2026-04-20T00:00:00.000Z",
    summary: "Summary",
    body: "Long body.".repeat(20),
    rawMetadata: {},
    ...overrides,
  };
}

function activeClient(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    clientId: "acme",
    name: "Acme",
    products: ["broker-dealer"],
    jurisdictions: ["US-federal"],
    frameworks: ["SEC-rule-15c3-1"],
    active: true,
    ...overrides,
  };
}

describe("createCrawlHandler", () => {
  it("indexes the corpus, fans out ClassifyJobs per active client, and marks dedup", async () => {
    const crawler: Crawler = {
      sourceId: "sec-edgar",
      async crawl() {
        return [ruleChange()];
      },
    };
    const crawlers = createCrawlerRegistry([crawler]);
    const dedup = createFakeDedup();
    const vectorStore = createFakeVectorStore();
    const indexer = createCorpusIndexer({
      embedder: createFakeEmbedder(),
      vectorStore,
      logger: silent,
    });
    const clients = createFakeClients([activeClient(), activeClient({ clientId: "beta" })]);
    const classifyQueue = inMemoryQueue();
    const audit = createFakeAudit();
    const handler = createCrawlHandler({
      crawlers,
      dedup,
      indexer,
      clients,
      classifyQueue,
      audit,
      logger: silent,
    });

    await handler({
      id: "j1",
      name: "crawl",
      data: { source: "sec-edgar" },
      attempts: 1,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
    });

    expect(classifyQueue.peek().map((j) => (j.data as { clientId: string }).clientId)).toEqual([
      "acme",
      "beta",
    ]);
    expect(await dedup.seen("sec-edgar", "rc-1")).toBe(true);
    expect(vectorStore.rows.length).toBeGreaterThan(0);
    expect(audit.events.map((e) => e.type)).toEqual(["RULE_CHANGE_DETECTED"]);
  });

  it("skips already-seen rule changes", async () => {
    const crawler: Crawler = {
      sourceId: "sec-edgar",
      async crawl() {
        return [ruleChange()];
      },
    };
    const dedup = createFakeDedup();
    await dedup.markSeen("sec-edgar", "rc-1", {
      url: "x",
      title: "y",
      firstSeenAt: "2026-04-20T00:00:00Z",
    });
    const classifyQueue = inMemoryQueue();
    const audit = createFakeAudit();
    const handler = createCrawlHandler({
      crawlers: createCrawlerRegistry([crawler]),
      dedup,
      indexer: createCorpusIndexer({
        embedder: createFakeEmbedder(),
        vectorStore: createFakeVectorStore(),
        logger: silent,
      }),
      clients: createFakeClients([activeClient()]),
      classifyQueue,
      audit,
      logger: silent,
    });
    await handler({
      id: "j1",
      name: "crawl",
      data: { source: "sec-edgar" },
      attempts: 1,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
    });
    expect(classifyQueue.peek()).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it("rejects unknown source", async () => {
    const handler = createCrawlHandler({
      crawlers: createCrawlerRegistry([]),
      dedup: createFakeDedup(),
      indexer: createCorpusIndexer({
        embedder: createFakeEmbedder(),
        vectorStore: createFakeVectorStore(),
        logger: silent,
      }),
      clients: createFakeClients([activeClient()]),
      classifyQueue: inMemoryQueue(),
      audit: createFakeAudit(),
      logger: silent,
    });
    await expect(
      handler({
        id: "j1",
        name: "crawl",
        data: { source: "unknown" },
        attempts: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/unknown crawler source/);
  });
});

describe("createClassifyHandler", () => {
  const classifier = createClassifier({
    llm: createFakeLlm({
      text: JSON.stringify({
        applicable: true,
        score: 90,
        confidence: "high",
        rationale: "direct hit on broker-dealer capital requirements",
      }),
    }),
    logger: silent,
    autoAlertThreshold: 80,
    reviewThreshold: 50,
  });

  const drafter = createMemoDrafter({
    llm: createFakeLlm({ text: "## Impact\nMemo body." }),
    logger: silent,
  });

  it("drafts a memo and enqueues publish for alert disposition", async () => {
    const memos = createFakeMemoStorage();
    const publishQueue = inMemoryQueue();
    const audit = createFakeAudit();
    const handler = createClassifyHandler({
      classifier,
      drafter,
      memos,
      notifier: async () => null, // skip notification in this test
      publishQueue,
      clients: createFakeClients([activeClient()]),
      audit,
      logger: silent,
    });

    await handler({
      id: "j1",
      name: "classify",
      data: { clientId: "acme", ruleChange: ruleChange() },
      attempts: 1,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
    });

    expect([...memos.memos.values()]).toHaveLength(1);
    expect(publishQueue.peek()).toHaveLength(1);
    expect(audit.events.map((e) => e.type)).toEqual(["APPLICABILITY_SCORED", "MEMO_DRAFTED"]);
  });

  it("does NOT enqueue publish for review disposition", async () => {
    const reviewClassifier = createClassifier({
      llm: createFakeLlm({
        text: JSON.stringify({
          applicable: true,
          score: 60,
          confidence: "medium",
          rationale: "adjacent",
        }),
      }),
      logger: silent,
      autoAlertThreshold: 80,
      reviewThreshold: 50,
    });
    const memos = createFakeMemoStorage();
    const publishQueue = inMemoryQueue();
    const handler = createClassifyHandler({
      classifier: reviewClassifier,
      drafter,
      memos,
      notifier: async () => null,
      publishQueue,
      clients: createFakeClients([activeClient()]),
      audit: createFakeAudit(),
      logger: silent,
    });
    await handler({
      id: "j1",
      name: "classify",
      data: { clientId: "acme", ruleChange: ruleChange() },
      attempts: 1,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
    });
    expect([...memos.memos.values()]).toHaveLength(1);
    expect(publishQueue.peek()).toHaveLength(0);
  });

  it("drops quietly when client was deactivated between enqueue and processing", async () => {
    const memos = createFakeMemoStorage();
    const publishQueue = inMemoryQueue();
    const handler = createClassifyHandler({
      classifier,
      drafter,
      memos,
      notifier: async () => null,
      publishQueue,
      clients: createFakeClients([activeClient({ active: false })]),
      audit: createFakeAudit(),
      logger: silent,
    });
    await handler({
      id: "j1",
      name: "classify",
      data: { clientId: "acme", ruleChange: ruleChange() },
      attempts: 1,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
    });
    expect([...memos.memos.values()]).toHaveLength(0);
    expect(publishQueue.peek()).toHaveLength(0);
  });
});

describe("createPublishHandler", () => {
  it("swallows ApprovalRequiredError as a soft-ack (memo not yet approved)", async () => {
    const memos = createFakeMemoStorage();
    memos.seed({
      memoId: "m-1",
      clientId: "acme",
      ruleChangeId: "rc-1",
      sourceId: "sec-edgar",
      status: "pending_review",
      title: "t",
      body: "b",
      model: "fake",
      createdAt: "2026-04-24T00:00:00Z",
      updatedAt: "2026-04-24T00:00:00Z",
    });
    const gate = createApprovalGate({
      memos,
      clients: createFakeClients([activeClient({ publish: { notionDatabaseId: "db" } })]),
      publishers: { notion: createFakePublisher("notion"), confluence: undefined },
      audit: createFakeAudit(),
      logger: silent,
    });
    const handler = createPublishHandler({ gate, logger: silent });
    await expect(
      handler({
        id: "j1",
        name: "publish",
        data: { memoId: "m-1", clientId: "acme" },
        attempts: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates non-approval errors to the consumer (DLQ path)", async () => {
    const memos = createFakeMemoStorage();
    memos.seed({
      memoId: "m-1",
      clientId: "acme",
      ruleChangeId: "rc-1",
      sourceId: "sec-edgar",
      status: "approved",
      title: "t",
      body: "b",
      model: "fake",
      createdAt: "2026-04-24T00:00:00Z",
      updatedAt: "2026-04-24T00:00:00Z",
    });
    const notion = createFakePublisher("notion");
    notion.failNext(new Error("notion 500"));
    const gate = createApprovalGate({
      memos,
      clients: createFakeClients([activeClient({ publish: { notionDatabaseId: "db" } })]),
      publishers: { notion, confluence: undefined },
      audit: createFakeAudit(),
      logger: silent,
    });
    const handler = createPublishHandler({ gate, logger: silent });
    await expect(
      handler({
        id: "j1",
        name: "publish",
        data: { memoId: "m-1", clientId: "acme" },
        attempts: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/notion 500/);
  });
});
