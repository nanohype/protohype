/**
 * Reads and parses the perf data source.
 * Tolerates missing data (returns empty sessions).
 * Validates with Zod — skips malformed records with a warning.
 */

import { PerfFileSchema, type Session } from "./schema";
import { computeCost, modelLabel } from "./pricing";
import type { EnrichedSession } from "./schema";
import { readPerfData } from "./storage";

export async function readSessions(): Promise<Session[]> {
  const raw = await readPerfData();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[reader] perf data is not valid JSON — treating as empty");
    return [];
  }

  const result = PerfFileSchema.safeParse(parsed);
  if (!result.success) {
    console.warn("[reader] perf data schema issues:", result.error.flatten());
    // Attempt partial parse — take what we can
    const rawSessions = (parsed as { sessions?: unknown[] })?.sessions ?? [];
    const valid: Session[] = [];
    for (const s of rawSessions) {
      const r = PerfFileSchema.shape.sessions.element.safeParse(s);
      if (r.success) valid.push(r.data);
    }
    return valid;
  }

  return result.data.sessions;
}

export function enrichSession(session: Session): EnrichedSession {
  const cost = computeCost(
    session.model,
    session.inputTokens,
    session.outputTokens,
    session.cacheReadTokens,
    session.cacheWriteTokens
  );

  const durationMs =
    session.completedAt
      ? new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()
      : null;

  const label = modelLabel(session.model);

  return {
    ...session,
    cost,
    durationMs,
    modelLabel: label as "sonnet" | "opus" | "haiku",
  };
}

export async function readEnrichedSessions(): Promise<EnrichedSession[]> {
  const sessions = await readSessions();
  return sessions.map(enrichSession);
}
