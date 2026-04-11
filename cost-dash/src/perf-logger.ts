/**
 * Perf Logger
 *
 * Drop this into your coordinator. Call logSession() after each agent
 * invocation to append a session record to the perf store.
 *
 * Usage in coordinator:
 *   import { logSession } from "./perf-logger.js";
 *   const usage = response.usage; // from Anthropic SDK
 *   await logSession({
 *     sessionId: response.id,
 *     startedAt: callStart,
 *     completedAt: new Date(),
 *     workflow: currentWorkflow,
 *     agentRole: agentRole,
 *     model: response.model,
 *     usage,
 *   });
 */

import { readPerfData, writePerfData } from "./storage";

export interface SessionLogEntry {
  sessionId: string;
  startedAt: Date;
  completedAt?: Date;
  workflow: string;
  agentRole: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  status?: "running" | "completed" | "failed";
}

// Serialize concurrent writes to prevent data loss
let writeLock: Promise<void> = Promise.resolve();

export async function logSession(entry: SessionLogEntry): Promise<void> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  await prev;

  try {
    // Read existing
    let data: { sessions: unknown[] } = { sessions: [] };
    const raw = await readPerfData();
    if (raw) {
      try {
        data = JSON.parse(raw) as { sessions: unknown[] };
        if (!Array.isArray(data.sessions)) data.sessions = [];
      } catch {
        // Corrupt data — start fresh
      }
    }

    const record = {
      sessionId: entry.sessionId,
      startedAt: entry.startedAt.toISOString(),
      completedAt: entry.completedAt?.toISOString(),
      workflow: entry.workflow,
      agentRole: entry.agentRole,
      model: entry.model,
      inputTokens: entry.usage.input_tokens,
      outputTokens: entry.usage.output_tokens,
      cacheReadTokens: entry.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: entry.usage.cache_creation_input_tokens ?? 0,
      status: entry.status ?? "completed",
    };

    data.sessions.push(record);
    await writePerfData(JSON.stringify(data, null, 2));
  } finally {
    resolve!();
  }
}
