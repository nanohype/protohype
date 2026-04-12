'use client';
import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';

interface AgentDetail {
  agentId: string;
  totalCostUsd: number;
  sessionCount: number;
  recentSessions: Array<{ sessionId: string; totalCostUsd: number; timestamp: string; workflow?: string }>;
}

function AgentDetail() {
  const searchParams = useSearchParams();
  const agentId = searchParams.get('id') ?? '';
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  // Start not-loading when there's no agentId — nothing to fetch.
  const [loading, setLoading] = useState(!!agentId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    api.agent(agentId)
      .then((d) => setDetail(d as AgentDetail))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  if (!agentId) return <div className="text-gray-500">No agent ID provided. <Link href="/agents" className="text-orange-400 hover:underline">Browse agents</Link></div>;
  if (loading) return <div className="text-gray-500 animate-pulse">Loading agent...</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  if (!detail) return null;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Link href="/agents" className="text-gray-500 text-sm hover:text-white">← All agents</Link>
        <h1 className="text-xl font-bold text-orange-400 mt-1">{detail.agentId}</h1>
        <p className="text-sm text-gray-500">${detail.totalCostUsd.toFixed(4)} total · {detail.sessionCount} sessions (90d)</p>
      </div>
      <div>
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Recent Sessions</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
              <th className="pb-2 pr-4">Session ID</th>
              <th className="pb-2 pr-4">Workflow</th>
              <th className="pb-2 pr-4 text-right">Cost</th>
              <th className="pb-2 text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            {detail.recentSessions.map((s) => (
              <tr key={s.sessionId} className="border-b border-gray-900 hover:bg-gray-900 transition-colors">
                <td className="py-2 pr-4 font-mono text-xs text-gray-400">{s.sessionId.slice(0, 12)}…</td>
                <td className="py-2 pr-4 text-gray-500">{s.workflow ?? '—'}</td>
                <td className="py-2 pr-4 text-right text-green-400">${s.totalCostUsd.toFixed(4)}</td>
                <td className="py-2 text-right text-gray-600 text-xs">{new Date(s.timestamp).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AgentDetailPage() {
  return (
    <Suspense fallback={<div className="text-gray-500 animate-pulse">Loading...</div>}>
      <AgentDetail />
    </Suspense>
  );
}
