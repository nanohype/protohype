/**
 * Stage 2 — Breaking Change Analyzer.
 *
 * Uses Claude Sonnet to identify which breaking changelog entries affect
 * specific files in the target codebase. Returns exact file:line locations
 * with a recommended patch strategy (mechanical vs human-review).
 *
 * The stable system prompt is cache-pointed. The breaking entries list is
 * also cache-pointed when used as a stable context prefix across multiple
 * file batches — reducing cost when a codebase has many files.
 */

import {
  converse,
  withSystemCachePoint,
  withContentCachePoint,
  extractJson,
  zeroUsage,
} from './bedrock-client.js';
import type { ChangelogEntry, CodebaseFile, AffectedUsage, LLMTokenUsage } from './types.js';

// ─── System prompt (stable — cache-pointed) ──────────────────────────────────

const SYSTEM_PROMPT = `You are a TypeScript/JavaScript static-analysis assistant. Given a list of breaking changelog entries and source files, identify every location in the source that is affected by each breaking change.

For each affected location output:
- filePath: relative path (as provided)
- lineNumber: 1-based line number of the affected code
- lineContent: the exact text of that line (trimmed)
- changelogEntryIndex: index (0-based) of the breaking entry that triggered this finding
- patchStrategy: "mechanical" if Kiln can rewrite the line automatically, "human-review" if human judgment is required
- patchStrategyReason: one sentence explaining why

A "mechanical" patch is only appropriate when:
1. The transformation is a simple symbol rename or import path change, AND
2. No business logic or type parameter changes are required, AND
3. The transformation is deterministic (one input → one output, no ambiguity).

Output ONLY a JSON object with key "affected" whose value is an array of finding objects.
If no locations are affected, output {"affected":[]}.
Do not include preamble, explanation, or code blocks.`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface AnalyzerFinding {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  changelogEntryIndex: number;
  patchStrategy: string;
  patchStrategyReason: string;
}

interface AnalyzerResponse {
  affected: AnalyzerFinding[];
}

// ─── Exported function ───────────────────────────────────────────────────────

export interface AnalyzeBreakingChangesResult {
  affectedUsages: AffectedUsage[];
  usage: LLMTokenUsage;
}

/** Max file characters to send in one analysis call (prevents context overflow). */
const MAX_FILE_CHARS_PER_CALL = 80_000;

/**
 * Analyze the target codebase for usages affected by the given breaking entries.
 * Batches large codebases into multiple calls to stay within context limits.
 */
export async function analyzeBreakingChanges(
  breakingEntries: ChangelogEntry[],
  codebaseFiles: CodebaseFile[],
): Promise<AnalyzeBreakingChangesResult> {
  if (breakingEntries.length === 0 || codebaseFiles.length === 0) {
    return { affectedUsages: [], usage: zeroUsage() };
  }

  // Batch files to avoid context overflow
  const batches = batchFiles(codebaseFiles, MAX_FILE_CHARS_PER_CALL);
  const allFindings: AnalyzerFinding[] = [];
  let totalUsage = zeroUsage();

  // Stable prefix: the breaking entries list (cache-pointed across file batches)
  const entriesJson = JSON.stringify(
    breakingEntries.map((e, i) => ({
      index: i,
      type: e.type,
      description: e.description,
      affectedSymbols: e.affectedSymbols,
    })),
  );
  const stableContext = `Breaking changelog entries to match against:\n${entriesJson}\n\nNow analyze the following source files:`;

  for (const batch of batches) {
    const filesJson = JSON.stringify(
      batch.map((f) => ({ filePath: f.filePath, content: f.content })),
    );

    const result = await converse({
      tier: 'default',
      system: withSystemCachePoint(SYSTEM_PROMPT),
      messages: [
        {
          role: 'user',
          content: withContentCachePoint(stableContext, filesJson),
        },
      ],
      maxTokens: 4096,
    });

    let parsed: AnalyzerResponse;
    try {
      parsed = extractJson<AnalyzerResponse>(result.text);
    } catch {
      throw Object.assign(
        new Error(`Breaking-change analyzer returned unparseable output: ${result.text.slice(0, 300)}`),
        { code: 'LLM_PARSE_ERROR' },
      );
    }

    if (!Array.isArray(parsed.affected)) {
      throw Object.assign(
        new Error('Analyzer response missing "affected" array'),
        { code: 'LLM_PARSE_ERROR' },
      );
    }

    allFindings.push(...parsed.affected);
    totalUsage = addUsages(totalUsage, result.usage);
  }

  const affectedUsages: AffectedUsage[] = allFindings.map((f) => {
    const entry = breakingEntries[f.changelogEntryIndex] ?? breakingEntries[0]!;
    return {
      filePath: f.filePath,
      lineNumber: f.lineNumber,
      lineContent: f.lineContent,
      changelogEntry: entry,
      patchStrategy: f.patchStrategy === 'mechanical' ? 'mechanical' : 'human-review',
      patchStrategyReason: f.patchStrategyReason,
    };
  });

  return { affectedUsages, usage: totalUsage };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function batchFiles(files: CodebaseFile[], maxChars: number): CodebaseFile[][] {
  const batches: CodebaseFile[][] = [];
  let current: CodebaseFile[] = [];
  let currentChars = 0;

  for (const file of files) {
    if (currentChars + file.content.length > maxChars && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(file);
    currentChars += file.content.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function addUsages(a: LLMTokenUsage, b: LLMTokenUsage): LLMTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
  };
}
