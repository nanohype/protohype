/**
 * Stage 4 — Migration Notes Writer.
 *
 * Uses Claude Sonnet to produce the Markdown "Migration Notes" section that
 * goes into every Kiln-authored PR description.
 *
 * Success criteria guarantee:
 *   - ≥1 changelog URL cited in the output
 *   - Every breaking change named by file:line (patched or flagged)
 *   - Human-review cases explicitly called out with suggested actions
 */

import {
  converse,
  withSystemCachePoint,
  withContentCachePoint,
  extractJson,
  zeroUsage,
} from './bedrock-client.js';
import type {
  FilePatch,
  HumanReviewCase,
  ChangelogEntry,
  MigrationNotes,
  LLMTokenUsage,
} from './types.js';

// ─── System prompt (stable — cache-pointed) ──────────────────────────────────

const SYSTEM_PROMPT = `You are a technical writer producing the Migration Notes section of a GitHub Pull Request description for a dependency upgrade authored by Kiln.

Your output must:
1. Start with "## Migration Notes" as the top-level heading.
2. Include a "### What Kiln Changed" subsection listing every mechanical patch by file:line with a one-sentence explanation.
3. Include a "### Needs Human Review" subsection (only if there are human-review cases) listing each case by file:line with the suggested action.
4. Include a "### Changelog References" subsection with the provided URLs as a bullet list.
5. Be accurate and precise — do not invent details not present in the provided data.
6. Use GitHub-flavored Markdown. Keep the tone matter-of-fact and engineer-facing.

Output ONLY a JSON object with these keys:
- markdown: the full Markdown string (the PR Migration Notes section)
- mechanicalPatchSummary: one sentence summarising the automated patches
- humanReviewSummary: one sentence summarising what needs human attention (empty string if none)

Do not wrap the JSON in a code fence. Do not include preamble.`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface WriterResponse {
  markdown: string;
  mechanicalPatchSummary: string;
  humanReviewSummary: string;
}

// ─── Exported function ───────────────────────────────────────────────────────

export interface WriteMigrationNotesResult {
  notes: MigrationNotes;
  usage: LLMTokenUsage;
}

export interface WriteMigrationNotesInput {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  changelogUrls: string[];
  patches: FilePatch[];
  humanReviewCases: HumanReviewCase[];
  breakingEntries: ChangelogEntry[];
}

export async function writeMigrationNotes(
  input: WriteMigrationNotesInput,
): Promise<WriteMigrationNotesResult> {
  if (input.changelogUrls.length === 0) {
    throw new Error(
      'writeMigrationNotes: at least one changelog URL must be provided (success criteria)',
    );
  }

  const stableContext = buildStableContext(input);
  const dynamicPayload = JSON.stringify({
    patches: input.patches.map((p) => ({
      filePath: p.filePath,
      lineNumber: p.lineNumber,
      explanation: p.explanation,
    })),
    humanReviewCases: input.humanReviewCases.map((c) => ({
      filePath: c.filePath,
      lineNumber: c.lineNumber,
      reason: c.reason,
      suggestedAction: c.suggestedAction,
    })),
  });

  const result = await converse({
    tier: 'default',
    system: withSystemCachePoint(SYSTEM_PROMPT),
    messages: [
      {
        role: 'user',
        content: withContentCachePoint(stableContext, dynamicPayload),
      },
    ],
    maxTokens: 3000,
  });

  let parsed: WriterResponse;
  try {
    parsed = extractJson<WriterResponse>(result.text);
  } catch {
    throw Object.assign(
      new Error(`Migration notes writer returned unparseable output: ${result.text.slice(0, 300)}`),
      { code: 'LLM_PARSE_ERROR' },
    );
  }

  // Enforce the "≥1 changelog URL cited" success criterion
  const citedUrls = input.changelogUrls.filter((url) =>
    parsed.markdown.includes(url),
  );
  if (citedUrls.length === 0) {
    // Append changelog references if the model omitted them
    parsed.markdown += buildChangelogSection(input.changelogUrls);
  }

  return {
    notes: {
      markdown: parsed.markdown,
      changelogUrls: input.changelogUrls,
      mechanicalPatchSummary: parsed.mechanicalPatchSummary ?? '',
      humanReviewSummary: parsed.humanReviewSummary ?? '',
    },
    usage: result.usage,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildStableContext(input: WriteMigrationNotesInput): string {
  return [
    `Package: ${input.packageName}`,
    `Upgrade: ${input.fromVersion} → ${input.toVersion}`,
    `Changelog URLs: ${input.changelogUrls.join(', ')}`,
    '',
    `Breaking changes identified by Kiln (${input.breakingEntries.length} total):`,
    ...input.breakingEntries.map((e) => `- ${e.description}`),
    '',
    'Patch and review data (dynamic):',
  ].join('\n');
}

function buildChangelogSection(urls: string[]): string {
  return [
    '',
    '### Changelog References',
    ...urls.map((u) => `- ${u}`),
  ].join('\n');
}

/** Fallback: produce minimal migration notes without calling the LLM.
 *  Used when the LLM call fails and we still need a valid PR description.
 */
export function buildFallbackNotes(
  input: WriteMigrationNotesInput,
): MigrationNotes {
  const patchLines = input.patches
    .map((p) => `- \`${p.filePath}:${p.lineNumber}\` — ${p.explanation}`)
    .join('\n');

  const reviewLines = input.humanReviewCases
    .map((c) => `- \`${c.filePath}:${c.lineNumber}\` — ${c.reason}\n  **Action**: ${c.suggestedAction}`)
    .join('\n');

  const markdown = [
    '## Migration Notes',
    '',
    '### What Kiln Changed',
    patchLines || '_No mechanical patches applied._',
    '',
    input.humanReviewCases.length > 0
      ? ['### Needs Human Review', reviewLines].join('\n')
      : '',
    '',
    buildChangelogSection(input.changelogUrls),
  ]
    .filter(Boolean)
    .join('\n');

  return {
    markdown,
    changelogUrls: input.changelogUrls,
    mechanicalPatchSummary: `Kiln applied ${input.patches.length} mechanical patch(es).`,
    humanReviewSummary:
      input.humanReviewCases.length > 0
        ? `${input.humanReviewCases.length} location(s) require human review.`
        : '',
  };
}
