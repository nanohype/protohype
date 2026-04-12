'use client';
import { useEffect, useState } from 'react';
import { api, WorkflowSummary } from '@/lib/api';
export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.workflows().then((r) => setWorkflows(r.workflows)).catch((e: Error) => setError(e.message)).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="text-gray-500 animate-pulse">Loading workflows...</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  const totalCost = workflows.reduce((s, w) => s + w.totalCostUsd, 0);
  return (
    <div className="max-w-4xl space-y-4">
      <div><h1 className="text-xl font-bold text-white">Workflow Cost Breakdown</h1><p className="text-sm text-gray-500">{workflows.length} workflows · ${totalCost.toFixed(4)} total (30d)</p></div>
      <div className="space-y-2">{workflows.map((wf) => {
        const pct = totalCost > 0 ? (wf.totalCostUsd / totalCost) * 100 : 0;
        return (
          <div key={wf.workflow} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex justify-between items-start mb-2">
              <div><div className="font-medium text-white">{wf.workflow}</div><div className="text-xs text-gray-500">{wf.agentCount} agents · {wf.sessionCount} sessions</div></div>
              <div className="text-right"><div className="text-green-400 font-bold">${wf.totalCostUsd.toFixed(4)}</div><div className="text-xs text-gray-500">{pct.toFixed(1)}% of total</div></div>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-1.5"><div className="bg-orange-500 h-1.5 rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} /></div>
          </div>
        );
      })}</div>
    </div>
  );
}
