/**
 * Aggregation layer — transforms enriched sessions into dashboard data structures.
 * Pure functions, no I/O — easy to test.
 */

import { startOfDay, format, subDays, isAfter } from "date-fns";
import type {
  EnrichedSession,
  DashboardSummary,
  AgentCost,
  WorkflowCost,
  DayBucket,
} from "./schema";

const DEFAULT_DAILY_BUDGET = parseFloat(process.env.DAILY_BUDGET_USD ?? "10");
const WARN_THRESHOLD = 0.8;

export function computeSummary(
  sessions: EnrichedSession[],
  dailyBudget = DEFAULT_DAILY_BUDGET
): DashboardSummary {
  const today = startOfDay(new Date());
  const todaySessions = sessions.filter(
    (s) => isAfter(new Date(s.startedAt), today)
  );

  const todayCost = todaySessions.reduce((sum, s) => sum + s.cost, 0);
  const todayInputTokens = todaySessions.reduce((sum, s) => sum + s.inputTokens, 0);
  const todayOutputTokens = todaySessions.reduce((sum, s) => sum + s.outputTokens, 0);

  // Cost by agent for today
  const agentCosts = new Map<string, number>();
  for (const s of todaySessions) {
    agentCosts.set(s.agentRole, (agentCosts.get(s.agentRole) ?? 0) + s.cost);
  }
  let topAgent: { role: string; cost: number } | null = null;
  for (const [role, cost] of agentCosts) {
    if (!topAgent || cost > topAgent.cost) topAgent = { role, cost };
  }

  // Burn rate: cost over hours elapsed today → project to 24h
  const nowMs = Date.now();
  const todayMs = today.getTime();
  const hoursElapsed = (nowMs - todayMs) / 3_600_000;
  const burnRatePerDay = hoursElapsed > 0.1 ? (todayCost / hoursElapsed) * 24 : 0;

  const budgetPercent = dailyBudget > 0 ? todayCost / dailyBudget : 0;
  const budgetStatus =
    budgetPercent >= 1 ? "over" : budgetPercent >= WARN_THRESHOLD ? "warn" : "ok";

  return {
    todayCost,
    todayInputTokens,
    todayOutputTokens,
    totalSessions: sessions.length,
    topAgent,
    burnRatePerDay,
    budgetPercent,
    budgetStatus,
    dailyBudget,
  };
}

export function computeAgentCosts(
  sessions: EnrichedSession[],
  filter: "session" | "today" | "week" | "all" = "today"
): AgentCost[] {
  const filtered = filterByTime(sessions, filter);
  const map = new Map<string, AgentCost>();

  for (const s of filtered) {
    const existing = map.get(s.agentRole) ?? {
      role: s.agentRole,
      cost: 0,
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    map.set(s.agentRole, {
      ...existing,
      cost: existing.cost + s.cost,
      sessions: existing.sessions + 1,
      inputTokens: existing.inputTokens + s.inputTokens,
      outputTokens: existing.outputTokens + s.outputTokens,
    });
  }

  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function computeWorkflowCosts(
  sessions: EnrichedSession[],
  filter: "session" | "today" | "week" | "all" = "today"
): WorkflowCost[] {
  const filtered = filterByTime(sessions, filter);
  const map = new Map<string, { cost: number; sessions: number }>();

  for (const s of filtered) {
    const existing = map.get(s.workflow) ?? { cost: 0, sessions: 0 };
    map.set(s.workflow, {
      cost: existing.cost + s.cost,
      sessions: existing.sessions + 1,
    });
  }

  return [...map.entries()]
    .map(([workflow, data]) => ({
      workflow,
      cost: data.cost,
      sessions: data.sessions,
      avgCostPerSession: data.sessions > 0 ? data.cost / data.sessions : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

export function computeDayBuckets(
  sessions: EnrichedSession[],
  days = 7
): DayBucket[] {
  const cutoff = subDays(startOfDay(new Date()), days - 1);
  const recent = sessions.filter((s) => isAfter(new Date(s.startedAt), cutoff));

  const map = new Map<string, DayBucket>();

  // Initialize all days so chart has no gaps
  for (let i = 0; i < days; i++) {
    const date = format(subDays(new Date(), days - 1 - i), "yyyy-MM-dd");
    map.set(date, {
      date,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      sonnetCost: 0,
      opusCost: 0,
      totalCost: 0,
    });
  }

  for (const s of recent) {
    const date = format(new Date(s.startedAt), "yyyy-MM-dd");
    const bucket = map.get(date);
    if (!bucket) continue;

    bucket.inputTokens += s.inputTokens;
    bucket.outputTokens += s.outputTokens;
    bucket.cacheReadTokens += s.cacheReadTokens;
    bucket.totalCost += s.cost;

    if (s.modelLabel === "opus") {
      bucket.opusCost += s.cost;
    } else {
      bucket.sonnetCost += s.cost;
    }
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function filterByTime(
  sessions: EnrichedSession[],
  filter: "session" | "today" | "week" | "all"
): EnrichedSession[] {
  if (filter === "all") return sessions;

  if (filter === "today") {
    const today = startOfDay(new Date());
    return sessions.filter((s) => isAfter(new Date(s.startedAt), today));
  }

  if (filter === "week") {
    const weekAgo = subDays(new Date(), 7);
    return sessions.filter((s) => isAfter(new Date(s.startedAt), weekAgo));
  }

  // "session" — most recent 20 sessions regardless of date
  return [...sessions]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20);
}
