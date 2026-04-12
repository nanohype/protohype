'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, AgentSummary } from '@/lib/api';
export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.agents().then((r) => setAgents(r.agents)).catch((e: Error) => setError(e.message)).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="text-gray-500 animate-pulse">Loading agents...</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  const totalCost = agents.reduce((s, a) => s + a.totalCostUsd, 0);
  return (
    <div className="max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-white">Agent Cost Breakdown</h1>
        <p className="text-sm text-gray-500">{agents.length} agents · ${totalCost.toFixed(4)} total spend (30d)</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
              <th className="pb-2 pr-4">Agent</th>
              <th className="pb-2 pr-4 text-right">Spend</th>
              <th className="pb-2 pr-4 text-right">% of Total</th>
              <th className="pb-2 pr-4 text-right">Input Tokens</th>
              <th className="pb-2 pr-4 text-right">Output Tokens</th>
              <th className="pb-2 pr-4 text-right">Sessions</th>
              <th className="pb-2 text-right">Last Active</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const pct = totalCost > 0 ? (agent.totalCostUsd / totalCost) * 100 : 0;
              return (
                <tr key={agent.agentId} className="border-b border-gray-900 hover:bg-gray-900 transition-colors">
                  <td className="py-2 pr-4"><Link href={`/agent?id=${encodeURIComponent(agent.agentId)}`} className="text-orange-400 hover:underline font-medium">{agent.agentId}</Link></td>
                  <td className="py-2 pr-4 text-right text-green-400">${agent.totalCostUsd.toFixed(4)}</td>
                  <td className="py-2 pr-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 bg-gray-800 rounded-full h-1"><div className="bg-orange-500 h-1 rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} /></div>
                      <span className="text-gray-400 w-10 text-right">{pct.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-right text-gray-400">{agent.totalInputTokens.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right text-gray-400">{agent.totalOutputTokens.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right text-gray-400">{agent.sessionCount}</td>
                  <td className="py-2 text-right text-gray-600 text-xs">{new Date(agent.lastActivity).toLocaleDateString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
