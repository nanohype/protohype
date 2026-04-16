/**
 * Stage 1 — Changelog Classifier.
 *
 * Uses Haiku (cheap, fast) to classify each raw changelog entry as
 * breaking / deprecation / feature / fix / security / unknown.
 * Batch-processes all entries in a single call to minimise latency and cost.
 * The system prompt is cache-pointed so warm calls skip prompt-processing tokens.
 */

import { converse, withSystemCachePoint, extractJson, zeroUsage } from './bedrock-client.js';
import type { ChangelogEntry, LLMTokenUsage } from './types.js';

// ─── System prompt (stable — cache-pointed) ──────────────────────────────────

const SYSTEM_PROMPT = `You are a dependency-changelog analyst. Your job is to classify changelog entries for npm packages.

For each entry, output:
- type: one of "breaking" | "deprecation" | "feature" | "fix" | "security" | "unknown"
- description: a concise one-sentence summary (max 120 chars)
- affectedSymbols: array of API names, function names, class names, or import paths mentioned (empty array if none)
- confidence: float 0-1 reflecting classification certainty

Rules:
- "breaking" means existing code WILL fail or behave differently without a code change.
- "deprecation" means an API still works but will be removed in a future version.
- "security" means a vulnerability was fixed — classify as "security" even if it is also a breaking change.
- When uncertain between "breaking" and "deprecation", prefer "breaking" (false-positive is safer than a miss).

Output ONLY a JSON object with a single key "entries" whose value is an array of classified objects.
Do not include any preamble, explanation, or trailing text outside the JSON.`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClassifierRawEntry {
  type: string;
  description: string;
  affectedSymbols: string[];
  confidence: number;
}

interface ClassifierResponse {
  entries: ClassifierRawEntry[];
}

// ─── Exported function ───────────────────────────────────────────────────────

export interface ClassifyChangelogResult {
  entries: ChangelogEntry[];
  usage: LLMTokenUsage;
}

/**
 * Classify all raw changelog entries in a single Bedrock Haiku call.
 * Returns typed ChangelogEntry objects with classification metadata.
 */
export async function classifyChangelog(
  rawEntries: string[],
): Promise<ClassifyChangelogResult> {
  if (rawEntries.length === 0) {
    return { entries: [], usage: zeroUsage() };
  }

  const userContent = JSON.stringify({ entries: rawEntries });

  const result = await converse({
    tier: 'classify',
    system: withSystemCachePoint(SYSTEM_PROMPT),
    messages: [{ role: 'user', content: [{ text: userContent }] }],
    maxTokens: 2048,
  });

  let parsed: ClassifierResponse;
  try {
    parsed = extractJson<ClassifierResponse>(result.text);
  } catch {
    throw Object.assign(
      new Error(`Changelog classifier returned unparseable output: ${result.text.slice(0, 300)}`),
      { code: 'LLM_PARSE_ERROR' },
    );
  }

  if (!Array.isArray(parsed.entries)) {
    throw Object.assign(
      new Error('Changelog classifier response missing "entries" array'),
      { code: 'LLM_PARSE_ERROR' },
    );
  }

  const validTypes = new Set([
    'breaking', 'deprecation', 'feature', 'fix', 'security', 'unknown',
  ]);

  const entries: ChangelogEntry[] = rawEntries.map((raw, i) => {
    const classified = parsed.entries[i];
    const type = validTypes.has(classified?.type ?? '') ? classified!.type : 'unknown';
    return {
      raw,
      type: type as ChangelogEntry['type'],
      description: classified?.description ?? raw.slice(0, 120),
      affectedSymbols: Array.isArray(classified?.affectedSymbols)
        ? classified!.affectedSymbols
        : [],
      confidence: typeof classified?.confidence === 'number'
        ? Math.max(0, Math.min(1, classified.confidence))
        : 0.5,
    };
  });

  return { entries, usage: result.usage };
}

/** Filter classified entries down to those that need codebase analysis. */
export function extractBreakingEntries(entries: ChangelogEntry[]): ChangelogEntry[] {
  return entries.filter((e) => e.type === 'breaking' || e.type === 'security');
}
