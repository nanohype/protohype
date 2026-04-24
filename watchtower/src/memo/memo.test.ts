import { describe, it, expect } from "vitest";
import { createMemoDrafter } from "./drafter.js";
import { createFakeLlm } from "../classifier/fake.js";
import { createFakeMemoStorage, ALLOWED_TRANSITIONS } from "./storage.js";
import { createLogger } from "../logger.js";
import type { RuleChange } from "../crawlers/types.js";
import type { ClientConfig } from "../clients/types.js";
import type { MemoRecord } from "./types.js";

const silent = createLogger("error", "memo-test");

const change: RuleChange = {
  sourceId: "sec-edgar",
  contentHash: "rc-1",
  title: "Proposed rule 15c3-1",
  url: "https://www.sec.gov/release",
  publishedAt: "2026-04-20T00:00:00Z",
  summary: "Intraday capital",
  body: "Full text...",
  rawMetadata: {},
};

const client: ClientConfig = {
  clientId: "acme",
  name: "Acme",
  products: ["broker-dealer"],
  jurisdictions: ["US-federal"],
  frameworks: ["SEC-rule-15c3-1"],
  active: true,
};

describe("createMemoDrafter", () => {
  it("produces a MemoRecord in pending_review", async () => {
    const drafter = createMemoDrafter({
      llm: createFakeLlm({
        text: "## Impact\n\nPara 1.\n\nPara 2.",
        modelId: "fake-claude",
      }),
      logger: silent,
    });
    const memo = await drafter.draft({ change, client, rationale: "direct hit" });
    expect(memo.status).toBe("pending_review");
    expect(memo.clientId).toBe("acme");
    expect(memo.ruleChangeId).toBe("rc-1");
    expect(memo.body).toContain("Para 1");
    expect(memo.model).toBe("fake-claude");
    expect(memo.memoId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("throws on empty LLM response (upstream decides retry vs. DLQ)", async () => {
    const drafter = createMemoDrafter({
      llm: createFakeLlm({ text: "   " }),
      logger: silent,
    });
    await expect(drafter.draft({ change, client, rationale: "x" })).rejects.toThrow(/empty/);
  });

  it("propagates LLM errors (no fail-secure here — memos draft or fail)", async () => {
    const drafter = createMemoDrafter({
      llm: createFakeLlm({ failWith: new Error("bedrock throttled") }),
      logger: silent,
    });
    await expect(drafter.draft({ change, client, rationale: "x" })).rejects.toThrow(
      "bedrock throttled",
    );
  });
});

describe("FakeMemoStorage", () => {
  const now = new Date().toISOString();
  const memo: MemoRecord = {
    memoId: "m-1",
    clientId: "acme",
    ruleChangeId: "rc-1",
    sourceId: "sec-edgar",
    status: "pending_review",
    title: "Impact: x",
    body: "memo body",
    model: "fake",
    createdAt: now,
    updatedAt: now,
  };

  it("rejects duplicate create with ConditionalCheckFailedException", async () => {
    const store = createFakeMemoStorage();
    await store.create(memo);
    await expect(store.create(memo)).rejects.toMatchObject({
      name: "ConditionalCheckFailedException",
    });
  });

  it("transition requires the `from` state to match current", async () => {
    const store = createFakeMemoStorage();
    await store.create(memo);
    await store.transition("m-1", "acme", "pending_review", { status: "approved" });
    await expect(
      store.transition("m-1", "acme", "pending_review", { status: "approved" }),
    ).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
  });

  it("getConsistent returns the latest state after transition", async () => {
    const store = createFakeMemoStorage();
    await store.create(memo);
    await store.transition("m-1", "acme", "pending_review", {
      status: "approved",
      approvedBy: "op@example.com",
      approvedAt: now,
    });
    const latest = await store.getConsistent("m-1", "acme");
    expect(latest?.status).toBe("approved");
    expect(latest?.approvedBy).toBe("op@example.com");
  });
});

describe("ALLOWED_TRANSITIONS", () => {
  it("documents the state machine (pending_review → approved|rejected; approved → published)", () => {
    expect(ALLOWED_TRANSITIONS.pending_review).toEqual(["approved", "rejected"]);
    expect(ALLOWED_TRANSITIONS.approved).toEqual(["published"]);
    expect(ALLOWED_TRANSITIONS.published).toEqual([]);
    expect(ALLOWED_TRANSITIONS.rejected).toEqual([]);
  });
});
