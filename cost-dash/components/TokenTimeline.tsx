"use client";

import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import type { DayBucket } from "@/src/schema";
import { formatTokens, formatCost } from "@/lib/format";
import { format, parseISO } from "date-fns";

interface Props {
  data: DayBucket[];
  days: number;
  onDaysChange: (d: number) => void;
}

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded p-3 text-xs font-mono min-w-[180px]">
      <div className="text-zinc-300 font-bold mb-2">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="text-zinc-100">
            {p.name.includes("cost") || p.name.includes("Cost")
              ? formatCost(p.value)
              : formatTokens(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

export default function TokenTimeline({ data, days, onDaysChange }: Props) {
  const formatted = data.map((d) => ({
    ...d,
    day: format(parseISO(d.date), "MMM d"),
  }));

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[11px] uppercase tracking-widest text-zinc-500">Token Usage & Cost</span>
        <div className="flex gap-1">
          {[7, 30].map((d) => (
            <button
              key={d}
              onClick={() => onDaysChange(d)}
              className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${
                days === d
                  ? "bg-blue-600 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={formatted} margin={{ left: 0, right: 40, top: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis
            dataKey="day"
            tick={{ fill: "#71717a", fontSize: 11, fontFamily: "monospace" }}
            axisLine={{ stroke: "#27272a" }}
            tickLine={false}
          />
          {/* Left Y: tokens */}
          <YAxis
            yAxisId="tokens"
            tickFormatter={(v) => formatTokens(v)}
            tick={{ fill: "#71717a", fontSize: 10, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            width={52}
          />
          {/* Right Y: cost */}
          <YAxis
            yAxisId="cost"
            orientation="right"
            tickFormatter={(v) => `$${v.toFixed(2)}`}
            tick={{ fill: "#71717a", fontSize: 10, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            formatter={(value) => (
              <span style={{ color: "#a1a1aa", fontSize: 11, fontFamily: "monospace" }}>{value}</span>
            )}
          />
          {/* Stacked bars: tokens */}
          <Bar yAxisId="tokens" dataKey="inputTokens" name="input" stackId="tokens" fill="#1e3a5f" animationDuration={300} />
          <Bar yAxisId="tokens" dataKey="outputTokens" name="output" stackId="tokens" fill="#3b82f6" animationDuration={300} />
          <Bar yAxisId="tokens" dataKey="cacheReadTokens" name="cache" stackId="tokens" fill="#93c5fd" animationDuration={300} />
          {/* Lines: cost by model */}
          <Line yAxisId="cost" type="monotone" dataKey="sonnetCost" name="sonnet cost" stroke="#3b82f6" dot={false} strokeWidth={2} animationDuration={300} />
          <Line yAxisId="cost" type="monotone" dataKey="opusCost" name="opus cost" stroke="#a855f7" dot={false} strokeWidth={2} animationDuration={300} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
