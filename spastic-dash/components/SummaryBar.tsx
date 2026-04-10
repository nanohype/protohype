"use client";

import type { DashboardSummary } from "@/src/schema";
import { formatCost, formatTokens } from "@/lib/format";

interface Props {
  summary: DashboardSummary;
}

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
}

function StatCard({ label, value, sub, valueColor = "text-zinc-50" }: StatCardProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-widest text-zinc-500">{label}</span>
      <span className={`text-2xl font-bold tabular ${valueColor}`}>{value}</span>
      {sub && <span className="text-xs text-zinc-500">{sub}</span>}
    </div>
  );
}

export default function SummaryBar({ summary }: Props) {
  const budgetColor =
    summary.budgetStatus === "over"
      ? "text-red-400"
      : summary.budgetStatus === "warn"
      ? "text-amber-400"
      : "text-green-400";

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard
        label="Today"
        value={formatCost(summary.todayCost)}
        sub={`${summary.totalSessions} sessions total`}
        valueColor={budgetColor}
      />
      <StatCard
        label="Tokens Today"
        value={formatTokens(summary.todayInputTokens + summary.todayOutputTokens)}
        sub={`${formatTokens(summary.todayInputTokens)} in / ${formatTokens(summary.todayOutputTokens)} out`}
      />
      <StatCard
        label="Top Agent"
        value={summary.topAgent?.role ?? "—"}
        sub={summary.topAgent ? formatCost(summary.topAgent.cost) + " today" : "no data"}
      />
      <StatCard
        label="Burn Rate"
        value={`${formatCost(summary.burnRatePerDay)}/day`}
        sub={`${Math.round(summary.budgetPercent * 100)}% of $${summary.dailyBudget} budget`}
        valueColor={budgetColor}
      />
    </div>
  );
}
