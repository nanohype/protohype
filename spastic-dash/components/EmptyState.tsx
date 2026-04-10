"use client";

import { useState } from "react";

interface Props {
  onSeedSample: () => void;
}

export default function EmptyState({ onSeedSample }: Props) {
  const [loading, setLoading] = useState(false);

  const handleSeed = async () => {
    setLoading(true);
    await onSeedSample();
    setLoading(false);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-3rem)] text-center px-4">
      <div className="text-4xl mb-6 text-zinc-700">⬡</div>
      <h2 className="text-zinc-300 font-bold text-lg mb-2">
        spastic // cost
      </h2>
      <p className="text-zinc-500 text-sm max-w-sm mb-1">
        No sessions recorded yet.
      </p>
      <p className="text-zinc-600 text-sm max-w-sm mb-8">
        The coordinator writes to{" "}
        <code className="text-zinc-400 bg-zinc-800 px-1 rounded">.spastic-perf.json</code>{" "}
        each time an agent runs. Run a workflow to start tracking costs.
      </p>
      <button
        onClick={handleSeed}
        disabled={loading}
        className="px-4 py-2 border border-zinc-700 rounded text-sm text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-50 font-mono"
      >
        {loading ? "seeding..." : "[ load sample data ]"}
      </button>
    </div>
  );
}
