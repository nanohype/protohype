import { describe, it, expect, beforeEach } from "vitest";
import { computeSummary, computeAgentCosts, computeWorkflowCosts, computeDayBuckets } from "../aggregator.js";
import type { EnrichedSession } from "../schema.js";

function makeSession(overrides: Partial<EnrichedSession> = {}): EnrichedSession {
  const now = new Date().toISOString();
  return {
    sessionId: `sess_${Math.random().toString(36).slice(2)}`,
    startedAt: now,
    completedAt: now,
    workflow: "feature-build",
    agentRole: "eng-frontend",
    model: "claude-sonnet-4-5",
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    status: "completed",
    cost: 0.06,
    durationMs: 60_000,
    modelLabel: "sonnet",
    ...overrides,
  };
}

describe("computeSummary", () => {
  it("returns zero values for empty sessions", () => {
    const summary = computeSummary([]);
    expect(summary.todayCost).toBe(0);
    expect(summary.todayInputTokens).toBe(0);
    expect(summary.topAgent).toBeNull();
    expect(summary.budgetStatus).toBe("ok");
  });

  it("sums today's costs correctly", () => {
    const sessions = [
      makeSession({ cost: 0.10 }),
      makeSession({ cost: 0.20 }),
    ];
    const summary = computeSummary(sessions, 10);
    expect(summary.todayCost).toBeCloseTo(0.30, 5);
  });

  it("identifies top agent by cost", () => {
    const sessions = [
      makeSession({ agentRole: "eng-ai", cost: 0.50 }),
      makeSession({ agentRole: "eng-frontend", cost: 0.10 }),
    ];
    const summary = computeSummary(sessions, 10);
    expect(summary.topAgent?.role).toBe("eng-ai");
    expect(summary.topAgent?.cost).toBeCloseTo(0.50, 5);
  });

  it("sets budgetStatus=warn when over 80% of budget", () => {
    const sessions = [makeSession({ cost: 8.50 })];
    const summary = computeSummary(sessions, 10);
    expect(summary.budgetStatus).toBe("warn");
  });

  it("sets budgetStatus=over when over 100% of budget", () => {
    const sessions = [makeSession({ cost: 11.00 })];
    const summary = computeSummary(sessions, 10);
    expect(summary.budgetStatus).toBe("over");
  });

  it("excludes yesterday's sessions from today totals", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const sessions = [
      makeSession({ startedAt: yesterday.toISOString(), cost: 5.00 }),
    ];
    const summary = computeSummary(sessions, 10);
    expect(summary.todayCost).toBe(0);
  });
});

describe("computeAgentCosts", () => {
  it("returns empty array for no sessions", () => {
    expect(computeAgentCosts([])).toEqual([]);
  });

  it("groups by agent role and sums costs", () => {
    const sessions = [
      makeSession({ agentRole: "eng-ai", cost: 0.30 }),
      makeSession({ agentRole: "eng-ai", cost: 0.20 }),
      makeSession({ agentRole: "eng-frontend", cost: 0.10 }),
    ];
    const costs = computeAgentCosts(sessions, "all");
    const ai = costs.find((c) => c.role === "eng-ai");
    expect(ai?.cost).toBeCloseTo(0.50, 5);
    expect(ai?.sessions).toBe(2);
  });

  it("sorts by cost descending", () => {
    const sessions = [
      makeSession({ agentRole: "cheap", cost: 0.01 }),
      makeSession({ agentRole: "expensive", cost: 1.00 }),
    ];
    const costs = computeAgentCosts(sessions, "all");
    expect(costs[0].role).toBe("expensive");
  });
});

describe("computeWorkflowCosts", () => {
  it("computes average cost per session correctly", () => {
    const sessions = [
      makeSession({ workflow: "feature-build", cost: 0.20 }),
      makeSession({ workflow: "feature-build", cost: 0.40 }),
    ];
    const costs = computeWorkflowCosts(sessions, "all");
    const fb = costs.find((c) => c.workflow === "feature-build");
    expect(fb?.avgCostPerSession).toBeCloseTo(0.30, 5);
  });
});

describe("computeDayBuckets", () => {
  it("returns exactly N day buckets", () => {
    const buckets = computeDayBuckets([], 7);
    expect(buckets).toHaveLength(7);
  });

  it("returns 30 day buckets when requested", () => {
    const buckets = computeDayBuckets([], 30);
    expect(buckets).toHaveLength(30);
  });

  it("buckets are sorted chronologically", () => {
    const buckets = computeDayBuckets([], 7);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].date > buckets[i - 1].date).toBe(true);
    }
  });

  it("accumulates today's session into today's bucket", () => {
    const today = new Date().toISOString().slice(0, 10);
    const sessions = [makeSession({ cost: 0.50, modelLabel: "sonnet" })];
    const buckets = computeDayBuckets(sessions, 7);
    const todayBucket = buckets.find((b) => b.date === today);
    expect(todayBucket?.totalCost).toBeCloseTo(0.50, 5);
    expect(todayBucket?.sonnetCost).toBeCloseTo(0.50, 5);
    expect(todayBucket?.opusCost).toBe(0);
  });
});
