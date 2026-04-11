"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";

interface Props {
  lastRefreshed: Date | null;
  refreshing: boolean;
  error: string | null;
}

export default function Header({ lastRefreshed, refreshing, error }: Props) {
  const [, setTick] = useState(0);

  // Tick every second to update "X seconds ago"
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const dotColor = error ? "bg-red-500" : refreshing ? "bg-amber-500" : "bg-green-500";
  const label = error
    ? "error"
    : refreshing
    ? "syncing"
    : lastRefreshed
    ? `refreshed ${formatDistanceToNow(lastRefreshed, { addSuffix: false })} ago`
    : "loading";

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="max-w-[1600px] mx-auto px-4 h-12 flex items-center justify-between">
        <span className="text-zinc-50 font-bold tracking-tight">
          cost{" "}
          <span className="text-zinc-500">{"// "}</span>
          <span className="text-zinc-300">dash</span>
        </span>

        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span
            className={`inline-block w-2 h-2 rounded-full ${dotColor} ${!refreshing && !error ? "pulse" : ""}`}
          />
          <span>{label}</span>
        </div>
      </div>
    </header>
  );
}
