/**
 * Core type definitions for the Kiln AI pipeline.
 *
 * Every shape here is a discriminated union or tagged record so stages are
 * independently testable and state transitions are explicit.
 */

// ─── Bedrock / LLM ───────────────────────────────────────────────────────────

export type KilnModelTier = 'classify' | 'default' | 'complex';

/** Token usage from a single Bedrock Converse call. */
export interface LLMTokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache (counts against cache-hit ratio). */
  cacheReadInputTokens: number;
  /** Tokens written to the prompt cache on this call. */
  cacheWriteInputTokens: number;
}

/** Accumulated token usage across all pipeline stages. */
export interface PipelineTokenUsage {
  classify: LLMTokenUsage;
  analyze: LLMTokenUsage;
  synthesize: LLMTokenUsage;
  writeNotes: LLMTokenUsage;
  total: LLMTokenUsage;
  /** cacheReadInputTokens / (inputTokens + cacheReadInputTokens) across total */
  cacheHitRatio: number;
}

// ─── Changelog ───────────────────────────────────────────────────────────────

export type ChangelogEntryType =
  | 'breaking'
  | 'deprecation'
  | 'feature'
  | 'fix'
  | 'security'
  | 'unknown';

export interface ChangelogEntry {
  /** Raw text from the vendor changelog. */
  raw: string;
  /** LLM-classified entry type. */
  type: ChangelogEntryType;
  /** Short description extracted by the classifier. */
  description: string;
  /**
   * Symbols, function names, or API surfaces mentioned in this entry.
   * Used downstream to focus codebase search.
   */
  affectedSymbols: string[];
  /** Confidence score 0-1. */
  confidence: number;
}

// ─── Codebase analysis ───────────────────────────────────────────────────────

/** A single file from the target codebase, passed to the analyzer. */
export interface CodebaseFile {
  /** Relative path from repo root (e.g. "src/services/dynamodb.ts"). */
  filePath: string;
  content: string;
}

/** A location in the codebase affected by a breaking change. */
export interface AffectedUsage {
  filePath: string;
  lineNumber: number;
  /** The exact line content at lineNumber. */
  lineContent: string;
  /** The breaking ChangelogEntry that triggers this usage. */
  changelogEntry: ChangelogEntry;
  /**
   * 'mechanical' → Kiln can write the patch automatically.
   * 'human-review' → transformation requires judgment Kiln cannot supply.
   */
  patchStrategy: 'mechanical' | 'human-review';
  /** Why mechanical patching applies or why it cannot. */
  patchStrategyReason: string;
}

// ─── Patches ─────────────────────────────────────────────────────────────────

/** A single line-level mechanical patch. */
export interface FilePatch {
  filePath: string;
  lineNumber: number;
  originalLine: string;
  patchedLine: string;
  /** Human-readable explanation written into the PR Migration Notes. */
  explanation: string;
  /** The changelog entry that motivated this patch. */
  sourceEntry: ChangelogEntry;
}

/** A usage Kiln cannot patch mechanically — flags for human review. */
export interface HumanReviewCase {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  /** Why Kiln cannot patch this automatically. */
  reason: string;
  /** Suggested action for the human reviewer. */
  suggestedAction: string;
  sourceEntry: ChangelogEntry;
}

// ─── Migration notes ─────────────────────────────────────────────────────────

export interface MigrationNotes {
  /** Full Markdown suitable for insertion into a GitHub PR description. */
  markdown: string;
  /** Vendor changelog URLs cited in the notes. Must be ≥1. */
  changelogUrls: string[];
  /** Summary of what Kiln changed automatically. */
  mechanicalPatchSummary: string;
  /** Summary of cases needing human judgment. */
  humanReviewSummary: string;
}

// ─── Pipeline I/O ────────────────────────────────────────────────────────────

export interface KilnPipelineInput {
  /** npm package name (e.g. "@aws-sdk/client-s3"). */
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** Full raw changelog text for the version range. */
  changelog: string;
  /** Vendor changelog URLs to cite. Must point to an allowlisted domain. */
  changelogUrls: string[];
  /** Files from the target codebase to analyze for usage. */
  codebaseFiles: CodebaseFile[];
}

export type KilnPipelineResult =
  | { status: 'success'; data: KilnMigrationPlan }
  | { status: 'error'; code: KilnErrorCode; message: string };

export type KilnErrorCode =
  | 'GUARDRAIL_URL_BLOCKED'
  | 'GUARDRAIL_PROMPT_INJECTION'
  | 'GUARDRAIL_INPUT_TOO_LARGE'
  | 'LLM_PARSE_ERROR'
  | 'LLM_TIMEOUT'
  | 'LLM_THROTTLED'
  | 'INTERNAL_ERROR';

export interface KilnMigrationPlan {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** Changelog entries classified as breaking (subset used for analysis). */
  breakingEntries: ChangelogEntry[];
  /** All affected usages found in the codebase. */
  affectedUsages: AffectedUsage[];
  /** Patches Kiln will apply mechanically. */
  patches: FilePatch[];
  /** Cases Kiln cannot patch — must be reviewed by a human. */
  humanReviewCases: HumanReviewCase[];
  migrationNotes: MigrationNotes;
  tokenUsage: PipelineTokenUsage;
}
