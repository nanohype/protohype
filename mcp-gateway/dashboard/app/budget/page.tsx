'use client';
import { useEffect, useState } from 'react';
import { api, Budget } from '@/lib/api';

function BudgetSection({ label, data }: { label: string; data: Budget['daily'] }) {
  const color = data.pct >= 90 ? 'text-red-400' : data.pct >= 70 ? 'text-yellow-400' : 'text-green-400';
  const barColor = data.pct >= 90 ? 'bg-red-500' : data.pct >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
      <div className="flex justify-between items-center">
        <span className="text-lg font-bold text-white">{label}</span>
        {data.alert && <span className="text-xs bg-red-900 border border-red-700 text-red-300 px-3 py-1 rounded-full font-medium">⚠ Budget Alert</span>}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div><div className="text-xs text-gray-500 mb-1">Spent</div><div className={`text-2xl font-bold ${color}`}>${data.spent.toFixed(4)}</div></div>
        <div><div className="text-xs text-gray-500 mb-1">Budget</div><div className="text-2xl font-bold text-white">${data.budget.toFixed(2)}</div></div>
        <div><div className="text-xs text-gray-500 mb-1">Remaining</div><div className="text-2xl font-bold text-gray-300">${data.remaining.toFixed(4)}</div></div>
      </div>
      <div>
        <div className="flex justify-between text-xs text-gray-500 mb-1"><span>Usage</span><span>{data.pct}%</span></div>
        <div className="w-full bg-gray-800 rounded-full h-3"><div className={`${barColor} h-3 rounded-full transition-all duration-700`} style={{ width: `${Math.min(data.pct, 100)}%` }} /></div>
      </div>
    </div>
  );
}

export default function BudgetPage() {
  const [budget, setBudget] = useState<Budget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.budget().then(setBudget).catch((e: Error) => setError(e.message)).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="text-gray-500 animate-pulse">Loading budget...</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  if (!budget) return null;
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Budget Status</h1>
        <p className="text-sm text-gray-500">Thresholds configured via Lambda environment variables DAILY_BUDGET_USD and MONTHLY_BUDGET_USD.</p>
      </div>
      <BudgetSection label="Daily Budget" data={budget.daily} />
      <BudgetSection label="Monthly Budget" data={budget.monthly} />
      <div className="text-xs text-gray-600 border-t border-gray-800 pt-4">Alerts fire at 80% of budget. Update Lambda env vars to change thresholds.</div>
    </div>
  );
}
