import { z } from "zod";

/** One agent invocation / session record in .spastic-perf.json */
export const SessionSchema = z.object({
  sessionId: z.string(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).optional(),
  workflow: z.string().default("unknown"),
  agentRole: z.string().default("unknown"),
  model: z.string().default("claude-sonnet-4-5"),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  cacheReadTokens: z.number().int().min(0).default(0),
  cacheWriteTokens: z.number().int().min(0).default(0),
  status: z.enum(["running", "completed", "failed"]).default("completed"),
});

export type Session = z.infer<typeof SessionSchema>;

/** The full .spastic-perf.json file shape */
export const PerfFileSchema = z.object({
  sessions: z.array(SessionSchema),
});

export type PerfFile = z.infer<typeof PerfFileSchema>;

/** Enriched session — includes computed cost and duration */
export interface EnrichedSession extends Session {
  cost: number;
  durationMs: number | null;
  modelLabel: "sonnet" | "opus" | "haiku";
}

/** Summary totals for the top stat cards */
export interface DashboardSummary {
  todayCost: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  totalSessions: number;
  topAgent: { role: string; cost: number } | null;
  burnRatePerDay: number;
  budgetPercent: number;
  budgetStatus: "ok" | "warn" | "over";
  dailyBudget: number;
}

/** Per-agent cost for bar chart */
export interface AgentCost {
  role: string;
  cost: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
}

/** Per-workflow cost for donut chart */
export interface WorkflowCost {
  workflow: string;
  cost: number;
  sessions: number;
  avgCostPerSession: number;
}

/** One day bucket for timeline chart */
export interface DayBucket {
  date: string; // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  sonnetCost: number;
  opusCost: number;
  totalCost: number;
}
