/**
 * Bedrock-powered changelog analyzer.
 *
 * Step 1 (Haiku): classify whether the changelog contains breaking changes.
 * Step 2 (Sonnet): extract the list of breaking changes as structured JSON.
 * Step 3 (Sonnet/Opus): for each breaking change + usage site, synthesize a patch.
 *
 * Prompt caching is enabled on the stable system prompts.
 */
import { converse, MODELS } from '../shared/bedrock';
import type { BreakingChange, ChangelogClassification, CodeUsage, MigrationResult } from '../shared/types';

// ─── Step 1: Haiku classification ────────────────────────────────────────────

const CLASSIFICATION_SYSTEM = `You are a technical changelog analyst. Your job is to determine whether a
software package changelog contains breaking changes that require code modifications.

Breaking changes include:
- Removed APIs, functions, methods, or properties
- Changed function signatures (parameter renames, type changes, added required parameters)
- Changed return types
- Renamed exports or modules
- Removed configuration options
- Behaviour changes that silently alter semantics

Respond ONLY with valid JSON matching this schema:
{"hasBreakingChanges": boolean, "confidence": "high"|"medium"|"low", "summary": string}`;

export async function classifyChangelog(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  changelogContent: string,
): Promise<{ hasBreakingChanges: boolean; confidence: string; summary: string }> {
  const result = await converse({
    modelId: MODELS.LIGHT,
    systemPrompt: CLASSIFICATION_SYSTEM,
    cacheSystemPrompt: true,
    userMessage: `Package: ${packageName}
Upgrading from: ${fromVersion}
Upgrading to: ${toVersion}

Changelog content:
${changelogContent}`,
    maxTokens: 256,
    temperature: 0,
  });

  try {
    const parsed = JSON.parse(result.content) as {
      hasBreakingChanges: boolean;
      confidence: string;
      summary: string;
    };
    return parsed;
  } catch {
    // If parsing fails, default to conservative: assume breaking changes
    return { hasBreakingChanges: true, confidence: 'low', summary: result.content };
  }
}

// ─── Step 2: Sonnet extraction ────────────────────────────────────────────────

const EXTRACTION_SYSTEM = `You are a migration expert for JavaScript/TypeScript packages.
Given a package changelog, extract every breaking change as structured data.

For each breaking change provide:
- description: human-readable description of what changed
- sourceUrl: the changelog URL (use the one provided)
- apiSurface: the specific API, function, class, or config key that changed
- migration: a clear, actionable migration instruction in one to three sentences

Respond ONLY with a JSON array of breaking change objects. No prose. No markdown fences.`;

export async function extractBreakingChanges(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  changelogContent: string,
  changelogUrl: string,
): Promise<BreakingChange[]> {
  const result = await converse({
    modelId: MODELS.DEFAULT,
    systemPrompt: EXTRACTION_SYSTEM,
    cacheSystemPrompt: true,
    userMessage: `Package: ${packageName}
Upgrading from: ${fromVersion}
Upgrading to: ${toVersion}
Changelog URL: ${changelogUrl}

Changelog content:
${changelogContent}`,
    maxTokens: 2048,
    temperature: 0,
  });

  try {
    const parsed = JSON.parse(result.content) as BreakingChange[];
    // Ensure every entry has the sourceUrl
    return parsed.map((c) => ({ ...c, sourceUrl: c.sourceUrl || changelogUrl }));
  } catch {
    // Return a single generic breaking change if parsing fails
    return [{
      description: 'Breaking changes detected — manual review required',
      sourceUrl: changelogUrl,
      apiSurface: 'unknown',
      migration: 'Review the changelog manually at the link above.',
    }];
  }
}

// ─── Step 3: Sonnet/Opus patch synthesis ─────────────────────────────────────

const PATCH_SYSTEM = `You are a senior TypeScript/JavaScript engineer performing automated code migration.
Given:
1. A breaking change description and migration instruction from the vendor changelog
2. The current code that uses the old API (with file path and line numbers)

Your task is to produce a mechanical patch that updates the code to the new API.

Rules:
- Only patch the specific lines that use the breaking API
- Preserve all surrounding logic, comments, and formatting
- If the change is not mechanical (requires semantic understanding, business logic, or
  architectural decisions), respond with {"kind": "human-review", "reason": "..."} explaining why.
- If the code does not actually use the breaking API (false positive), respond with
  {"kind": "no-usage"}
- For successful patches, respond with:
  {"kind": "patched", "startLine": N, "endLine": N, "replacement": "..."}

Respond ONLY with valid JSON. No markdown fences. No prose.`;

export async function synthesizePatch(
  change: BreakingChange,
  usage: CodeUsage,
): Promise<
  | { kind: 'patched'; startLine: number; endLine: number; replacement: string }
  | { kind: 'human-review'; reason: string }
  | { kind: 'no-usage' }
> {
  // Use Opus for complex multi-line changes; Sonnet for simpler ones
  const isComplex = usage.lines.length > 5 || (change.migration?.length ?? 0) > 200;
  const model = isComplex ? MODELS.ESCALATION : MODELS.DEFAULT;

  const result = await converse({
    modelId: model,
    systemPrompt: PATCH_SYSTEM,
    cacheSystemPrompt: true,
    userMessage: `Breaking change:
${change.description}

API surface: ${change.apiSurface ?? 'unknown'}
Migration instruction: ${change.migration ?? 'See changelog'}

File: ${usage.file}
Lines ${usage.lines[0]}–${usage.lines[usage.lines.length - 1]}:
${usage.excerpt}`,
    maxTokens: 1024,
    temperature: 0,
  });

  try {
    return JSON.parse(result.content) as
      | { kind: 'patched'; startLine: number; endLine: number; replacement: string }
      | { kind: 'human-review'; reason: string }
      | { kind: 'no-usage' };
  } catch {
    return {
      kind: 'human-review',
      reason: `Patch synthesis failed to return valid JSON. Raw response: ${result.content.slice(0, 200)}`,
    };
  }
}

// ─── Orchestrated analysis ────────────────────────────────────────────────────

/**
 * Full analysis pipeline for a single breaking change across a set of usage sites.
 * Returns a MigrationResult for each usage site.
 */
export async function analyzeAndSynthesize(
  change: BreakingChange,
  usages: CodeUsage[],
): Promise<MigrationResult[]> {
  if (usages.length === 0) {
    return [{ kind: 'no-usage', change }];
  }

  const results: MigrationResult[] = [];
  for (const usage of usages) {
    const patch = await synthesizePatch(change, usage);
    if (patch.kind === 'no-usage') {
      results.push({ kind: 'no-usage', change });
    } else if (patch.kind === 'human-review') {
      results.push({ kind: 'human-review', change, usages: [usage], reason: patch.reason });
    } else {
      results.push({
        kind: 'patched',
        change,
        usages: [usage],
        patches: [{
          file: usage.file,
          startLine: patch.startLine,
          endLine: patch.endLine,
          original: usage.excerpt,
          replacement: patch.replacement,
          breakingChangeDescription: change.description,
        }],
      });
    }
  }
  return results;
}

/**
 * Full changelog analysis: classify → extract → synthesize.
 * Returns the classification and all migration results.
 */
export async function analyzeChangelog(params: {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  changelogContent: string;
  changelogUrl: string;
  codeUsages: Map<string, CodeUsage[]>;   // breaking-change apiSurface → usages
}): Promise<ChangelogClassification> {
  const classification = await classifyChangelog(
    params.packageName,
    params.fromVersion,
    params.toVersion,
    params.changelogContent,
  );

  if (!classification.hasBreakingChanges) {
    return { hasBreakingChanges: false };
  }

  const breakingChanges = await extractBreakingChanges(
    params.packageName,
    params.fromVersion,
    params.toVersion,
    params.changelogContent,
    params.changelogUrl,
  );

  return { hasBreakingChanges: true, breakingChanges };
}
