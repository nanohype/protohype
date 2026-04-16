/**
 * Kiln AI package public API.
 *
 * eng-backend integrates by importing { runKilnPipeline } and the shared types.
 * All other exports are internal implementation details.
 */

export { runKilnPipeline, splitChangelogEntries } from './pipeline.js';
export { validatePipelineInput, validatePatches, validateMigrationNotes, isUrlAllowed } from './guardrails.js';
export { classifyChangelog, extractBreakingEntries } from './changelog-classifier.js';
export { analyzeBreakingChanges } from './breaking-change-analyzer.js';
export { synthesizeMigration } from './migration-synthesizer.js';
export { writeMigrationNotes, buildFallbackNotes } from './migration-notes-writer.js';
export { setBedrockClient, cacheHitRatio } from './bedrock-client.js';
export type {
  KilnPipelineInput,
  KilnPipelineResult,
  KilnMigrationPlan,
  KilnErrorCode,
  ChangelogEntry,
  AffectedUsage,
  FilePatch,
  HumanReviewCase,
  MigrationNotes,
  CodebaseFile,
  PipelineTokenUsage,
  LLMTokenUsage,
} from './types.js';
