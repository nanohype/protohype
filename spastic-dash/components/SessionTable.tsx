"use client";

import { useState } from "react";
import { formatDistanceToNow, parseISO } from "date-fns";
import type { EnrichedSession } from "@/src/schema";
import { formatCost } from "@/lib/format";
import ModelBadge from "./ModelBadge";

interface Props {
  sessions: EnrichedSession[];
  total: number;
  page: number;
  onPageChange: (p: number) => void;
  search: string;
  onSearchChange: (q: string) => void;
}

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function costColor(cost: number): string {
  if (cost > 1.0) return "text-red-400";
  if (cost > 0.25) return "text-amber-400";
  return "text-green-400";
}

export default function SessionTable({ sessions, total, page, onPageChange, search, onSearchChange }: Props) {
  const perPage = 50;
  const totalPages = Math.ceil(total / perPage);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <span className="text-[11px] uppercase tracking-widest text-zinc-500">
          Session Log <span className="text-zinc-600 ml-1">({total})</span>
        </span>
        <input
          type="text"
          placeholder="search workflow, agent..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-blue-600 w-52"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-zinc-800">
              {["Time", "Workflow", "Agent", "Model", "In", "Out", "Cache", "Cost", "Dur"].map((col) => (
                <th
                  key={col}
                  className="px-3 py-2 text-left text-[10px] uppercase tracking-widest text-zinc-600 font-normal whitespace-nowrap"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-zinc-600">
                  {search ? "no sessions match your search" : "no sessions"}
                </td>
              </tr>
            ) : (
              sessions.map((s) => (
                <tr key={s.sessionId} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                  <td className="px-3 py-2 text-zinc-500 whitespace-nowrap" title={s.startedAt}>
                    {formatDistanceToNow(parseISO(s.startedAt), { addSuffix: true })}
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{s.workflow}</td>
                  <td className="px-3 py-2 text-zinc-300">{s.agentRole}</td>
                  <td className="px-3 py-2"><ModelBadge label={s.modelLabel} /></td>
                  <td className="px-3 py-2 text-zinc-400 tabular text-right">{(s.inputTokens / 1000).toFixed(1)}k</td>
                  <td className="px-3 py-2 text-zinc-400 tabular text-right">{(s.outputTokens / 1000).toFixed(1)}k</td>
                  <td className="px-3 py-2 text-zinc-600 tabular text-right">
                    {s.cacheReadTokens > 0 ? `${(s.cacheReadTokens / 1000).toFixed(1)}k` : "—"}
                  </td>
                  <td className={`px-3 py-2 tabular text-right font-bold ${costColor(s.cost)}`}>
                    {formatCost(s.cost)}
                  </td>
                  <td className="px-3 py-2 text-zinc-500 tabular">{formatDuration(s.durationMs)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-800">
          <span className="text-xs text-zinc-600">
            page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              className="px-3 py-1 rounded text-xs bg-zinc-800 text-zinc-400 disabled:opacity-30 hover:bg-zinc-700 transition-colors"
            >
              ← prev
            </button>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
              className="px-3 py-1 rounded text-xs bg-zinc-800 text-zinc-400 disabled:opacity-30 hover:bg-zinc-700 transition-colors"
            >
              next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
