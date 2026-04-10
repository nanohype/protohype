/**
 * Reads and parses the .spastic-perf.json data source.
 * Tolerates missing file (returns empty sessions).
 * Validates with Zod — skips malformed records with a warning.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { PerfFileSchema, type Session } from "./schema.js";
import { computeCost, modelLabel, type ModelPricing } from "./pricing.js";
import type { EnrichedSession } from "./schema.js";

export function getPerfFilePath(): string {
  return process.env.SPASTIC_PERF_FILE ?? path.join(process.cwd(), ".spastic-perf.json");
}

export async function readSessions(): Promise<Session[]> {
  const filePath = getPerfFilePath();

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return []; // no file yet — empty state
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[reader] .spastic-perf.json is not valid JSON — treating as empty");
    return [];
  }

  const result = PerfFileSchema.safeParse(parsed);
  if (!result.success) {
    console.warn("[reader] .spastic-perf.json schema issues:", result.error.flatten());
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
