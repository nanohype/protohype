"use client";

import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import type { WorkflowCost } from "@/src/schema";
import { formatCost } from "@/lib/format";
import TimeFilter from "./TimeFilter";

interface Props {
  data: WorkflowCost[];
  filter: "session" | "today" | "week" | "all";
  onFilterChange: (f: "session" | "today" | "week" | "all") => void;
}

const COLORS = [
  "#3b82f6", "#a855f7", "#22c55e", "#f59e0b",
  "#06b6d4", "#ef4444", "#8b5cf6", "#10b981",
];

const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: WorkflowCost }> }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded p-3 text-xs font-mono">
      <div className="text-zinc-300 font-bold mb-1">{d.workflow}</div>
      <div className="text-zinc-400">total: <span className="text-zinc-100">{formatCost(d.cost)}</span></div>
      <div className="text-zinc-400">sessions: <span className="text-zinc-100">{d.sessions}</span></div>
      <div className="text-zinc-400">avg/session: <span className="text-zinc-100">{formatCost(d.avgCostPerSession)}</span></div>
    </div>
  );
};

export default function WorkflowDonut({ data, filter, onFilterChange }: Props) {
  // Collapse > 8 workflows to "other"
  const top = data.slice(0, 7);
  const other = data.slice(7);
  const chartData = other.length > 0
    ? [...top, {
        workflow: "other",
        cost: other.reduce((s, d) => s + d.cost, 0),
        sessions: other.reduce((s, d) => s + d.sessions, 0),
        avgCostPerSession: 0,
      }]
    : top;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[11px] uppercase tracking-widest text-zinc-500">Cost by Workflow</span>
        <TimeFilter value={filter} onChange={onFilterChange} />
      </div>

      {chartData.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-zinc-600 text-sm">no data</div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie
              data={chartData}
              dataKey="cost"
              nameKey="workflow"
              innerRadius={60}
              outerRadius={90}
              paddingAngle={2}
              animationDuration={300}
            >
              {chartData.map((entry, i) => (
                <Cell key={entry.workflow} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
            <Legend
              formatter={(value) => (
                <span style={{ color: "#a1a1aa", fontSize: 11, fontFamily: "monospace" }}>{value}</span>
              )}
            />
          </PieChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
