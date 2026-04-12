'use client';
import { useEffect, useState } from 'react';
import { api, Summary, Budget } from '@/lib/api';

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</div>
      <div className="text-2xl font-bold text-white">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

function BudgetBar({ label, data }: { label: string; data: Budget['daily'] }) {
  const color = data.pct >= 90 ? 'bg-red-500' : data.pct >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="stat-card">
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm text-gray-400">{label}</span>
        {data.alert && <span className="text-xs bg-red-900 text-red-300 px-2 py-0.5 rounded-full alert-pulse">⚠ ALERT</span>}
      </div>
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>${data.spent.toFixed(4)} spent</span>
        <span>${data.budget.toFixed(2)} budget</span>
      </div>
      <div className="w-full bg-gray-800 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all duration-500`} style={{ width: `${Math.min(data.pct, 100)}%` }} />
      </div>
      <div className="text-right text-xs text-gray-500 mt-1">{data.pct}%</div>
    </div>
  );
}

export default function SummaryPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    Promise.all([api.summary(), api.budget()])
      .then(([s, b]) => { setSummary(s); setBudget(b); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  if (loading) return <div className="text-gray-500 animate-pulse">Loading...</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  if (!summary || !budget) return null;
  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-bold text-white mb-1">Overview</h1>
        <p className="text-sm text-gray-500">Last 30 days · {summary.agentCount} agents · {summary.sessionCount} sessions</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Spend" value={`$${summary.totalCostUsd.toFixed(4)}`} sub="last 30 days" />
        <StatCard label="Input Tokens" value={summary.totalInputTokens.toLocaleString()} />
        <StatCard label="Output Tokens" value={summary.totalOutputTokens.toLocaleString()} />
        <StatCard label="Sessions" value={summary.sessionCount} sub={`${summary.agentCount} active agents`} />
      </div>
      <div>
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Budget Status</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <BudgetBar label="Daily Budget" data={budget.daily} />
          <BudgetBar label="Monthly Budget" data={budget.monthly} />
        </div>
      </div>
      <div className="text-xs text-gray-600 border-t border-gray-800 pt-4">
        Data sourced from S3 cost events written by perf-logger.
        <a href="/agents" className="text-orange-400 hover:underline ml-2">View agent breakdown →</a>
      </div>
    </div>
  );
}
