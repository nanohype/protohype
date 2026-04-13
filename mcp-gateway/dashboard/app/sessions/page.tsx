'use client';
import { useEffect, useState } from 'react';
import { api, Session } from '@/lib/api';
export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.sessions().then((r) => setSessions(r.sessions)).catch((e: Error) => setError(e.message)).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="text-gray-500 animate-pulse">Loading sessions...</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  return (
    <div className="max-w-6xl space-y-4">
      <div><h1 className="text-xl font-bold text-white">Recent Sessions</h1><p className="text-sm text-gray-500">{sessions.length} sessions · last 7 days</p></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
            <th className="pb-2 pr-4">Session ID</th><th className="pb-2 pr-4">Agent</th>
            <th className="pb-2 pr-4">Workflow</th><th className="pb-2 pr-4 text-right">Cost</th>
            <th className="pb-2 text-right">Time</th>
          </tr></thead>
          <tbody>{sessions.map((s) => (
            <tr key={s.sessionId} className="border-b border-gray-900 hover:bg-gray-900 transition-colors">
              <td className="py-2 pr-4 font-mono text-xs text-gray-400">{s.sessionId.slice(0,12)}…</td>
              <td className="py-2 pr-4 text-orange-400">{s.agentId}</td>
              <td className="py-2 pr-4 text-gray-500">{s.workflow ?? '—'}</td>
              <td className="py-2 pr-4 text-right text-green-400">${s.totalCostUsd.toFixed(4)}</td>
              <td className="py-2 text-right text-gray-600 text-xs">{new Date(s.timestamp).toLocaleString()}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
