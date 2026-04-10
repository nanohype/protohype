"use client";

import { useState } from "react";
import type { DashboardSummary } from "@/src/schema";
import { formatCost } from "@/lib/format";

interface Props {
  summary: DashboardSummary;
}

export default function BudgetBanner({ summary }: Props) {
  const [dismissed, setDismissed] = useState(false);

  if (summary.budgetStatus === "ok" || dismissed) return null;

  const isOver = summary.budgetStatus === "over";
  const remaining = summary.dailyBudget - summary.todayCost;
  const pct = Math.round(summary.budgetPercent * 100);

  return (
    <div
      className={`flex items-center justify-between px-4 py-2.5 rounded-lg border text-sm ${
        isOver
          ? "bg-red-950/50 border-red-800 text-red-300"
          : "bg-amber-950/50 border-amber-800 text-amber-300"
      }`}
    >
      <span>
        {isOver ? "🔴" : "⚠️"}{" "}
        {isOver
          ? `Daily budget exceeded — ${formatCost(summary.dailyBudget)} limit reached. ${formatCost(Math.abs(remaining))} over.`
          : `${pct}% of ${formatCost(summary.dailyBudget)} daily budget used — ${formatCost(remaining)} remaining`}
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="text-zinc-500 hover:text-zinc-300 ml-4 text-lg leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
