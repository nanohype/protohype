/**
 * Kiln AI Pipeline — end-to-end orchestrator.
 *
 * Stages:
 *   1. Guardrail validation (synchronous, no LLM calls)
 *   2. Changelog classification  — Haiku (cheap, fast)
 *   3. Breaking change analysis  — Sonnet (one call per file batch)
 *   4. Migration synthesis       — Sonnet / Opus (mechanical patches + review cases)
 *   5. Migration notes writer    — Sonnet (PR description section)
 *   6. Output guardrail validation (synchronous)
 *
 * Token usage and cache-hit ratio are tracked across all stages and surfaced
 * in the returned KilnMigrationPlan for cost-reporting dashboards.
 */

import { classifyChangelog, extractBreakingEntries } from './changelog-classifier.js';
import { analyzeBreakingChanges } from './breaking-change-analyzer.js';
import { synthesizeMigration } from './migration-synthesizer.js';
import { writeMigrationNotes, buildFallbackNotes } from './migration-notes-writer.js';
import {
  validatePipelineInput,
  validatePatches,
  validateMigrationNotes,
} from './guardrails.js';
import { addUsage, cacheHitRatio, zeroUsage } from './bedrock-client.js';
import type {
  KilnPipelineInput,
  KilnPipelineResult,
  KilnMigrationPlan,
  PipelineTokenUsage,
  LLMTokenUsage,
} from './types.js';

// ─── Changelog entry splitter ─────────────────────────────────────────────────

/**
 * Split a raw changelog blob into individual entries.
 * Handles common changelog formats:
 *   - `## v3.0.0` / `### Changes` (heading-delimited)
 *   - `- text` / `* text` (bullet-delimited — treated as one entry each)
 */
export function splitChangelogEntries(changelog: string): string[] {
  const lines = changelog.split('\n');
  const entries: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Heading = new entry boundary
    if (/^#{2,4}\s/.test(trimmed)) {
      if (current.length > 0) entries.push(current.join('\n').trim());
      current = [trimmed];
    } else if (/^[-*]\s/.test(trimmed) && current.length === 0) {
      // Stand-alone bullet = one entry
      entries.push(trimmed);
    } else {
      current.push(trimmed);
    }
  }
  if (current.length > 0) entries.push(current.join('\n').trim());

  return entries.filter(Boolean);
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export async function runKilnPipeline(
  input: KilnPipelineInput,
): Promise<KilnPipelineResult> {
  // ── Stage 0: Input guardrails ──
  const guardResult = validatePipelineInput(input);
  if (!guardResult.ok) {
    return {
      status: 'error',
      code: guardResult.error.type,
      message: formatGuardrailMessage(guardResult.error),
    };
  }

  // ── Stage 1: Classify changelog entries (Haiku) ──
  const rawEntries = splitChangelogEntries(input.changelog);
  let classifyUsage: LLMTokenUsage = zeroUsage();
  let breakingEntries;

  try {
    const classifyResult = await classifyChangelog(rawEntries);
    classifyUsage = classifyResult.usage;
    breakingEntries = extractBreakingEntries(classifyResult.entries);
  } catch (err) {
    return mapLlmError(err);
  }

  // ── Stage 2: Analyze codebase for affected usages (Sonnet) ──
  let analyzeUsage: LLMTokenUsage = zeroUsage();
  let affectedUsages;

  try {
    const analyzeResult = await analyzeBreakingChanges(
      breakingEntries,
      input.codebaseFiles,
    );
    analyzeUsage = analyzeResult.usage;
    affectedUsages = analyzeResult.affectedUsages;
  } catch (err) {
    return mapLlmError(err);
  }

  // ── Stage 3: Synthesize patches (Sonnet / Opus) ──
  let synthesizeUsage: LLMTokenUsage = zeroUsage();
  let patches;
  let humanReviewCases;

  try {
    const synthResult = await synthesizeMigration(affectedUsages);
    synthesizeUsage = synthResult.usage;
    patches = synthResult.patches;
    humanReviewCases = synthResult.humanReviewCases;
  } catch (err) {
    return mapLlmError(err);
  }

  // ── Stage 3b: Output guardrail — validate patches ──
  const patchValidation = validatePatches(patches);
  if (!patchValidation.valid) {
    return {
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: `Generated patches failed validation: ${patchValidation.errors.join('; ')}`,
    };
  }

  // ── Stage 4: Write migration notes (Sonnet) ──
  let notesUsage: LLMTokenUsage = zeroUsage();
  let migrationNotes;

  try {
    const notesResult = await writeMigrationNotes({
      packageName: input.packageName,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      changelogUrls: input.changelogUrls,
      patches,
      humanReviewCases,
      breakingEntries,
    });
    notesUsage = notesResult.usage;
    migrationNotes = notesResult.notes;
  } catch (err) {
    // Migration notes are non-blocking — fall back to template-generated notes
    // rather than failing the whole pipeline.
    migrationNotes = buildFallbackNotes({
      packageName: input.packageName,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      changelogUrls: input.changelogUrls,
      patches,
      humanReviewCases,
      breakingEntries,
    });
  }

  // ── Stage 4b: Output guardrail — validate migration notes ──
  const notesValidation = validateMigrationNotes(migrationNotes);
  if (!notesValidation.valid) {
    // Patch the notes rather than failing the pipeline
    migrationNotes = buildFallbackNotes({
      packageName: input.packageName,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      changelogUrls: input.changelogUrls,
      patches,
      humanReviewCases,
      breakingEntries,
    });
  }

  // ── Assemble token usage report ──
  const totalUsage = [classifyUsage, analyzeUsage, synthesizeUsage, notesUsage].reduce(
    addUsage,
    zeroUsage(),
  );

  const tokenUsage: PipelineTokenUsage = {
    classify: classifyUsage,
    analyze: analyzeUsage,
    synthesize: synthesizeUsage,
    writeNotes: notesUsage,
    total: totalUsage,
    cacheHitRatio: cacheHitRatio(totalUsage),
  };

  const plan: KilnMigrationPlan = {
    packageName: input.packageName,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    breakingEntries,
    affectedUsages,
    patches,
    humanReviewCases,
    migrationNotes,
    tokenUsage,
  };

  return { status: 'success', data: plan };
}

// ─── Error helpers ────────────────────────────────────────────────────────────

function mapLlmError(err: unknown): KilnPipelineResult {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'LLM_TIMEOUT') return { status: 'error', code: 'LLM_TIMEOUT', message: e.message };
  if (e.code === 'LLM_PARSE_ERROR') return { status: 'error', code: 'LLM_PARSE_ERROR', message: e.message };
  if (e.message?.includes('ThrottlingException')) {
    return { status: 'error', code: 'LLM_THROTTLED', message: e.message };
  }
  return { status: 'error', code: 'INTERNAL_ERROR', message: e.message ?? 'Unknown error' };
}

type GuardrailErr = {
  type: 'GUARDRAIL_URL_BLOCKED'; url: string;
} | {
  type: 'GUARDRAIL_PROMPT_INJECTION'; field: string;
} | {
  type: 'GUARDRAIL_INPUT_TOO_LARGE'; field: string; chars: number; limit: number;
};

function formatGuardrailMessage(error: GuardrailErr): string {
  switch (error.type) {
    case 'GUARDRAIL_URL_BLOCKED':
      return `Changelog URL blocked by domain allowlist: ${error.url}`;
    case 'GUARDRAIL_PROMPT_INJECTION':
      return `Potential prompt injection detected in field: ${error.field}`;
    case 'GUARDRAIL_INPUT_TOO_LARGE':
      return `Input field "${error.field}" exceeds limit: ${error.chars} chars (max ${error.limit})`;
  }
}
