"use client";

interface Props {
  value: "session" | "today" | "week" | "all";
  onChange: (v: "session" | "today" | "week" | "all") => void;
}

const OPTIONS = [
  { key: "session" as const, label: "session" },
  { key: "today" as const, label: "today" },
  { key: "week" as const, label: "week" },
  { key: "all" as const, label: "all" },
];

export default function TimeFilter({ value, onChange }: Props) {
  return (
    <div className="flex gap-1">
      {OPTIONS.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
            value === opt.key
              ? "bg-blue-600 text-white"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
