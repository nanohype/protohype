"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import type { AgentCost } from "@/src/schema";
import { formatCost } from "@/lib/format";
import TimeFilter from "./TimeFilter";

interface Props {
  data: AgentCost[];
  filter: "session" | "today" | "week" | "all";
  onFilterChange: (f: "session" | "today" | "week" | "all") => void;
}

const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: AgentCost }> }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded p-3 text-xs font-mono">
      <div className="text-zinc-300 font-bold mb-1">{d.role}</div>
      <div className="text-zinc-400">cost: <span className="text-zinc-100">{formatCost(d.cost)}</span></div>
      <div className="text-zinc-400">sessions: <span className="text-zinc-100">{d.sessions}</span></div>
    </div>
  );
};

export default function AgentCostChart({ data, filter, onFilterChange }: Props) {
  const top = data.slice(0, 12); // max 12 agents visible

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[11px] uppercase tracking-widest text-zinc-500">Cost by Agent</span>
        <TimeFilter value={filter} onChange={onFilterChange} />
      </div>

      {top.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-zinc-600 text-sm">no data</div>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(200, top.length * 32)}>
          <BarChart data={top} layout="vertical" margin={{ left: 8, right: 40, top: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={false} />
            <XAxis
              type="number"
              tickFormatter={(v) => `$${v.toFixed(2)}`}
              tick={{ fill: "#71717a", fontSize: 11, fontFamily: "monospace" }}
              axisLine={{ stroke: "#27272a" }}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="role"
              width={110}
              tick={{ fill: "#a1a1aa", fontSize: 11, fontFamily: "monospace" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: "#27272a" }} />
            <Bar dataKey="cost" radius={[0, 3, 3, 0]} animationDuration={300}>
              {top.map((entry, i) => (
                <Cell
                  key={entry.role}
                  fill={`rgba(59, 130, 246, ${1 - (i / top.length) * 0.6})`}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
