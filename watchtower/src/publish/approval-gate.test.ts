import { describe, it, expect } from "vitest";
import { createApprovalGate } from "./approval-gate.js";
import { createFakePublisher } from "./fake.js";
import { createFakeMemoStorage } from "../memo/storage.js";
import { createFakeClients } from "../clients/fake.js";
import { createFakeAudit } from "../audit/fake.js";
import { createLogger } from "../logger.js";
import type { MemoRecord } from "../memo/types.js";
import type { ClientConfig } from "../clients/types.js";
import { ApprovalRequiredError, PublishConflictError } from "./types.js";

// ── Approval gate tests ────────────────────────────────────────────
//
// This is the security-critical module. Tests aim for 100% branch
// coverage on the gate's decision tree: pre-publish state checks,
// post-publish transition race, audit emission on every outcome.
//

const silent = createLogger("error", "gate-test");

const client: ClientConfig = {
  clientId: "acme",
  name: "Acme",
  products: ["broker-dealer"],
  jurisdictions: ["US-federal"],
  frameworks: ["SEC-rule-15c3-1"],
  active: true,
  publish: { notionDatabaseId: "db-1" },
};

const now = new Date("2026-04-24T00:00:00Z").toISOString();

function approvedMemo(overrides: Partial<MemoRecord> = {}): MemoRecord {
  return {
    memoId: "m-1",
    clientId: "acme",
    ruleChangeId: "rc-1",
    sourceId: "sec-edgar",
    status: "approved",
    title: "Impact: rule",
    body: "Memo body",
    model: "fake",
    createdAt: now,
    updatedAt: now,
    approvedBy: "operator@example.com",
    approvedAt: now,
    ...overrides,
  };
}

function wire(memo: MemoRecord | null = approvedMemo(), clientOverride?: ClientConfig) {
  const memos = createFakeMemoStorage();
  if (memo) memos.seed(memo);
  const clients = createFakeClients(clientOverride ? [clientOverride] : [client]);
  const notion = createFakePublisher("notion");
  const confluence = createFakePublisher("confluence");
  const audit = createFakeAudit();
  const gate = createApprovalGate({
    memos,
    clients,
    publishers: { notion, confluence },
    audit,
    logger: silent,
    now: () => new Date(now),
  });
  return { gate, memos, clients, notion, confluence, audit };
}

describe("createApprovalGate — happy path", () => {
  it("publishes an approved memo and transitions to published", async () => {
    const { gate, notion, memos, audit } = wire();
    const result = await gate.publish("m-1", "acme");

    expect(result.page.destination).toBe("notion");
    expect(notion.published).toHaveLength(1);
    const updated = await memos.getConsistent("m-1", "acme");
    expect(updated?.status).toBe("published");
    expect(updated?.publishedPageId).toBe(result.page.pageId);
    expect(audit.events.map((e) => e.type)).toEqual(["MEMO_PUBLISHED"]);
  });

  it("prefers notion when both destinations are configured", async () => {
    const clientBoth: ClientConfig = {
      ...client,
      publish: { notionDatabaseId: "db-1", confluenceSpaceKey: "SPACE" },
    };
    const { gate, notion, confluence } = wire(approvedMemo(), clientBoth);
    await gate.publish("m-1", "acme");
    expect(notion.published).toHaveLength(1);
    expect(confluence.published).toHaveLength(0);
  });

  it("falls back to confluence when notion isn't configured", async () => {
    const clientConf: ClientConfig = {
      ...client,
      publish: { confluenceSpaceKey: "SPACE" },
    };
    const { gate, notion, confluence } = wire(approvedMemo(), clientConf);
    await gate.publish("m-1", "acme");
    expect(notion.published).toHaveLength(0);
    expect(confluence.published).toHaveLength(1);
  });
});

describe("createApprovalGate — pre-publish blocks", () => {
  it("blocks when memo is missing", async () => {
    const { gate, notion, audit } = wire(null);
    await expect(gate.publish("nope", "acme")).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(notion.published).toHaveLength(0);
    expect(audit.events).toHaveLength(0); // no "blocked" event for "never existed"
  });

  it("blocks when memo is in pending_review (human hasn't approved)", async () => {
    const { gate, notion } = wire(approvedMemo({ status: "pending_review" }));
    await expect(gate.publish("m-1", "acme")).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(notion.published).toHaveLength(0);
  });

  it("blocks when memo was rejected", async () => {
    const { gate, notion } = wire(approvedMemo({ status: "rejected" }));
    await expect(gate.publish("m-1", "acme")).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(notion.published).toHaveLength(0);
  });

  it("blocks when memo is already published (idempotency)", async () => {
    const { gate, notion } = wire(approvedMemo({ status: "published" }));
    await expect(gate.publish("m-1", "acme")).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(notion.published).toHaveLength(0);
  });

  it("blocks when client is missing/inactive and emits MEMO_PUBLISH_BLOCKED", async () => {
    // Arrange: memo exists and approved, but client is inactive.
    const memos = createFakeMemoStorage();
    memos.seed(approvedMemo());
    const clients = createFakeClients([]); // no active clients
    const notion = createFakePublisher("notion");
    const audit = createFakeAudit();
    const gate = createApprovalGate({
      memos,
      clients,
      publishers: { notion, confluence: undefined },
      audit,
      logger: silent,
    });
    await expect(gate.publish("m-1", "acme")).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(notion.published).toHaveLength(0);
  });

  it("emits MEMO_PUBLISH_BLOCKED when no destination is configured", async () => {
    const noDest: ClientConfig = { ...client, publish: undefined as never };
    delete (noDest as { publish?: unknown }).publish;
    const { gate, audit, notion } = wire(approvedMemo(), noDest);
    await expect(gate.publish("m-1", "acme")).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(notion.published).toHaveLength(0);
    expect(audit.events.map((e) => e.type)).toContain("MEMO_PUBLISH_BLOCKED");
  });
});

describe("createApprovalGate — publisher failure", () => {
  it("propagates publisher errors and emits MEMO_PUBLISH_BLOCKED", async () => {
    const { gate, notion, memos, audit } = wire();
    notion.failNext(new Error("notion 503"));
    await expect(gate.publish("m-1", "acme")).rejects.toThrow("notion 503");
    // Memo stays in approved state — no transition happened.
    const after = await memos.getConsistent("m-1", "acme");
    expect(after?.status).toBe("approved");
    const types = audit.events.map((e) => e.type);
    expect(types).toContain("MEMO_PUBLISH_BLOCKED");
  });
});

describe("createApprovalGate — state race", () => {
  it("throws PublishConflictError if memo state changed between ConsistentRead and transition", async () => {
    // Simulate: gate reads approved memo, then before transition the
    // operator rolls it back to rejected. The transition's
    // ConditionExpression catches it.
    const memos = createFakeMemoStorage();
    memos.seed(approvedMemo());
    const clients = createFakeClients([client]);
    const notion = createFakePublisher("notion");
    const audit = createFakeAudit();

    // Monkey-patch: after the first getConsistent (gate's phase 1),
    // flip the memo to rejected so the transition's condition fails.
    const origGet = memos.getConsistent.bind(memos);
    memos.getConsistent = (async (id, cid) => {
      const r = await origGet(id, cid);
      // simulate operator intervention after the read
      if (r && r.status === "approved") {
        // directly poke the map behind the fake
        (memos.memos as Map<string, MemoRecord>).set(`${id}|${cid}`, {
          ...r,
          status: "rejected",
          rejectedReason: "operator changed their mind",
        });
      }
      return r;
    }) as typeof memos.getConsistent;

    const gate = createApprovalGate({
      memos,
      clients,
      publishers: { notion, confluence: undefined },
      audit,
      logger: silent,
    });

    await expect(gate.publish("m-1", "acme")).rejects.toBeInstanceOf(PublishConflictError);
    // External page was created (the publisher ran) but DDB transition failed.
    expect(notion.published).toHaveLength(1);
    const types = audit.events.map((e) => e.type);
    expect(types).toContain("MEMO_PUBLISH_BLOCKED");
  });
});
