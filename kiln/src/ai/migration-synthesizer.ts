/**
 * Stage 3 — Migration Synthesizer.
 *
 * Takes the list of affected usages (from Stage 2) and generates:
 *   - FilePatch objects for mechanical transformations (Sonnet by default)
 *   - HumanReviewCase objects for cases that need human judgment
 *
 * Escalates to Opus when the average complexity score across all mechanical
 * usages exceeds KILN_COMPLEXITY_THRESHOLD (default 7 on a 0-10 scale).
 * Complexity is estimated from the number of affected symbols and the degree
 * of type-parameter changes indicated in the changelog entries.
 */

import {
  converse,
  withSystemCachePoint,
  withContentCachePoint,
  extractJson,
  zeroUsage,
} from './bedrock-client.js';
import type {
  AffectedUsage,
  ChangelogEntry,
  FilePatch,
  HumanReviewCase,
  LLMTokenUsage,
} from './types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const COMPLEXITY_THRESHOLD =
  parseInt(process.env['KILN_COMPLEXITY_THRESHOLD'] ?? '7', 10);

// ─── System prompts (stable — cache-pointed) ─────────────────────────────────

const MECHANICAL_SYSTEM_PROMPT = `You are a TypeScript/JavaScript migration engineer. Given a list of affected code locations and their corresponding breaking changelog entries, produce a mechanical patch for each location.

For each location, output:
- filePath: relative path (as provided)
- lineNumber: 1-based line number
- originalLine: the exact original line (must match what was provided)
- patchedLine: the replacement line after applying the migration
- explanation: one sentence describing what changed and why (for the PR Migration Notes)
- complexityScore: integer 0-10 (0 = trivial rename, 10 = requires understanding business logic)

Rules:
- Only produce "mechanical" patches — deterministic rewrites with no ambiguity.
- Preserve indentation exactly.
- Do not change lines other than the specified line number.
- The patchedLine must be valid TypeScript/JavaScript syntax.
- If a location marked "mechanical" turns out to require judgment after closer inspection, set complexityScore to 10 and include a note in explanation.

Output ONLY a JSON object with key "patches" whose value is an array.
Do not include preamble or code fences.`;

const HUMAN_REVIEW_SYSTEM_PROMPT = `You are a TypeScript/JavaScript migration advisor. Given a list of code locations that cannot be patched mechanically, write a clear action item for the human reviewer for each location.

For each location, output:
- filePath: relative path (as provided)
- lineNumber: 1-based line number
- lineContent: the exact original line (as provided)
- reason: why Kiln cannot patch this automatically (one sentence)
- suggestedAction: concrete guidance for the human reviewer (1-3 sentences)

Output ONLY a JSON object with key "cases" whose value is an array.
Do not include preamble or code fences.`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface SynthesizerPatch {
  filePath: string;
  lineNumber: number;
  originalLine: string;
  patchedLine: string;
  explanation: string;
  complexityScore: number;
}

interface SynthesizerResponse {
  patches: SynthesizerPatch[];
}

interface HumanReviewRaw {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  reason: string;
  suggestedAction: string;
}

interface HumanReviewResponse {
  cases: HumanReviewRaw[];
}

// ─── Exported function ───────────────────────────────────────────────────────

export interface SynthesizeMigrationResult {
  patches: FilePatch[];
  humanReviewCases: HumanReviewCase[];
  usage: LLMTokenUsage;
}

export async function synthesizeMigration(
  affectedUsages: AffectedUsage[],
): Promise<SynthesizeMigrationResult> {
  if (affectedUsages.length === 0) {
    return { patches: [], humanReviewCases: [], usage: zeroUsage() };
  }

  const mechanicalUsages = affectedUsages.filter((u) => u.patchStrategy === 'mechanical');
  const reviewUsages = affectedUsages.filter((u) => u.patchStrategy === 'human-review');

  let totalUsage = zeroUsage();
  let patches: FilePatch[] = [];
  let humanReviewCases: HumanReviewCase[] = [];

  // ── Mechanical patches ──
  if (mechanicalUsages.length > 0) {
    const tier = estimateComplexity(mechanicalUsages) >= COMPLEXITY_THRESHOLD
      ? 'complex'
      : 'default';

    const stableContext = buildMechanicalContext(mechanicalUsages);
    const dynamicInput = JSON.stringify(
      mechanicalUsages.map((u, i) => ({
        index: i,
        filePath: u.filePath,
        lineNumber: u.lineNumber,
        lineContent: u.lineContent,
        changelogDescription: u.changelogEntry.description,
        affectedSymbols: u.changelogEntry.affectedSymbols,
      })),
    );

    const result = await converse({
      tier,
      system: withSystemCachePoint(MECHANICAL_SYSTEM_PROMPT),
      messages: [
        {
          role: 'user',
          content: withContentCachePoint(stableContext, dynamicInput),
        },
      ],
      maxTokens: 4096,
    });

    let parsed: SynthesizerResponse;
    try {
      parsed = extractJson<SynthesizerResponse>(result.text);
    } catch {
      throw Object.assign(
        new Error(`Migration synthesizer returned unparseable output: ${result.text.slice(0, 300)}`),
        { code: 'LLM_PARSE_ERROR' },
      );
    }

    patches = (parsed.patches ?? []).map((p, i) => {
      const usage = mechanicalUsages[i];
      const entry: ChangelogEntry = usage?.changelogEntry ?? {
        raw: '',
        type: 'breaking',
        description: '',
        affectedSymbols: [],
        confidence: 0.5,
      };
      return {
        filePath: p.filePath,
        lineNumber: p.lineNumber,
        originalLine: p.originalLine,
        patchedLine: p.patchedLine,
        explanation: p.explanation,
        sourceEntry: entry,
      };
    });

    totalUsage = addUsages(totalUsage, result.usage);
  }

  // ── Human-review cases ──
  if (reviewUsages.length > 0) {
    const stableContext = buildReviewContext(reviewUsages);
    const dynamicInput = JSON.stringify(
      reviewUsages.map((u) => ({
        filePath: u.filePath,
        lineNumber: u.lineNumber,
        lineContent: u.lineContent,
        patchStrategyReason: u.patchStrategyReason,
        changelogDescription: u.changelogEntry.description,
        affectedSymbols: u.changelogEntry.affectedSymbols,
      })),
    );

    const result = await converse({
      tier: 'default',
      system: withSystemCachePoint(HUMAN_REVIEW_SYSTEM_PROMPT),
      messages: [
        {
          role: 'user',
          content: withContentCachePoint(stableContext, dynamicInput),
        },
      ],
      maxTokens: 2048,
    });

    let parsed: HumanReviewResponse;
    try {
      parsed = extractJson<HumanReviewResponse>(result.text);
    } catch {
      throw Object.assign(
        new Error(`Human-review synthesizer returned unparseable output: ${result.text.slice(0, 300)}`),
        { code: 'LLM_PARSE_ERROR' },
      );
    }

    humanReviewCases = (parsed.cases ?? []).map((c, i) => {
      const usage = reviewUsages[i];
      const entry: ChangelogEntry = usage?.changelogEntry ?? {
        raw: '',
        type: 'breaking',
        description: '',
        affectedSymbols: [],
        confidence: 0.5,
      };
      return {
        filePath: c.filePath,
        lineNumber: c.lineNumber,
        lineContent: c.lineContent,
        reason: c.reason,
        suggestedAction: c.suggestedAction,
        sourceEntry: entry,
      };
    });

    totalUsage = addUsages(totalUsage, result.usage);
  }

  return { patches, humanReviewCases, usage: totalUsage };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function estimateComplexity(usages: AffectedUsage[]): number {
  if (usages.length === 0) return 0;
  // Proxy: number of affected symbols + whether descriptions mention type params
  const scores = usages.map((u) => {
    const symbolScore = Math.min(u.changelogEntry.affectedSymbols.length * 1.5, 6);
    const typeParamScore = /generic|type param|<T|extends|interface/i.test(
      u.changelogEntry.description,
    )
      ? 3
      : 0;
    return Math.min(symbolScore + typeParamScore, 10);
  });
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function buildMechanicalContext(usages: AffectedUsage[]): string {
  const packages = [...new Set(usages.map((u) => u.changelogEntry.raw.slice(0, 80)))];
  return `Context: mechanical patches required for the following affected locations.
Package changelog entries involved:\n${packages.join('\n')}\n\nLocations to patch:`;
}

function buildReviewContext(usages: AffectedUsage[]): string {
  const reasons = [...new Set(usages.map((u) => u.patchStrategyReason))];
  return `Context: human review required for the following locations.
Reasons why mechanical patching was not applied:\n${reasons.join('\n')}\n\nLocations:`;
}

function addUsages(a: LLMTokenUsage, b: LLMTokenUsage): LLMTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
  };
}
