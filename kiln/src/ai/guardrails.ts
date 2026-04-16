/**
 * Input and output guardrails for the Kiln AI pipeline.
 *
 * Every agent-facing input is untrusted. These guards run synchronously
 * before any LLM call to prevent:
 *   - SSRF via crafted changelog URLs (domain allowlist)
 *   - Prompt-injection via changelog text
 *   - Context-overflow attacks via oversized inputs
 *
 * Output guards validate that patches meet minimum quality criteria.
 */

import type { FilePatch, KilnPipelineInput, MigrationNotes } from './types.js';

// ─── URL allowlist ────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_DOMAINS = [
  'github.com',
  'raw.githubusercontent.com',
  'npmjs.com',
  'registry.npmjs.org',
  'aws.amazon.com',
  'docs.aws.amazon.com',
  'reactjs.org',
  'react.dev',
  'nextjs.org',
  'prisma.io',
  'typescriptlang.org',
];

function getAllowedDomains(): string[] {
  const envOverride = process.env['KILN_CHANGELOG_DOMAIN_ALLOWLIST'];
  if (envOverride) return envOverride.split(',').map((d) => d.trim());
  return DEFAULT_ALLOWED_DOMAINS;
}

export function isUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // malformed URL
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return getAllowedDomains().some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

// ─── Prompt injection detection ───────────────────────────────────────────────

// Patterns that indicate an attempt to override the system prompt via changelog
// text. This list covers common techniques; not exhaustive.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /forget\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+a/i,
  /act\s+as\s+(if\s+you\s+are\s+)?a/i,
  /\[SYSTEM\]/i,
  /<\/?system>/i,
  /<<SYS>>/i,
  /\[INST\]/i,
  /human:\s*\n/i,
  /assistant:\s*\n/i,
];

export function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

// ─── Size limits ──────────────────────────────────────────────────────────────

/** Max total characters across all codebase files (prevents context-overflow). */
const MAX_CODEBASE_CHARS = 500_000;

/** Max changelog text length (a 50-page changelog is ~100k chars). */
const MAX_CHANGELOG_CHARS = 200_000;

// ─── Input guardrail ─────────────────────────────────────────────────────────

export type GuardrailError =
  | { type: 'GUARDRAIL_URL_BLOCKED'; url: string }
  | { type: 'GUARDRAIL_PROMPT_INJECTION'; field: string }
  | { type: 'GUARDRAIL_INPUT_TOO_LARGE'; field: string; chars: number; limit: number };

export type GuardrailResult =
  | { ok: true }
  | { ok: false; error: GuardrailError };

export function validatePipelineInput(input: KilnPipelineInput): GuardrailResult {
  // 1. Validate changelog URLs against allowlist
  for (const url of input.changelogUrls) {
    if (!isUrlAllowed(url)) {
      return { ok: false, error: { type: 'GUARDRAIL_URL_BLOCKED', url } };
    }
  }

  // 2. Prompt injection in changelog text
  if (detectPromptInjection(input.changelog)) {
    return {
      ok: false,
      error: { type: 'GUARDRAIL_PROMPT_INJECTION', field: 'changelog' },
    };
  }

  // 3. Size limits
  if (input.changelog.length > MAX_CHANGELOG_CHARS) {
    return {
      ok: false,
      error: {
        type: 'GUARDRAIL_INPUT_TOO_LARGE',
        field: 'changelog',
        chars: input.changelog.length,
        limit: MAX_CHANGELOG_CHARS,
      },
    };
  }

  const codebaseChars = input.codebaseFiles.reduce((sum, f) => sum + f.content.length, 0);
  if (codebaseChars > MAX_CODEBASE_CHARS) {
    return {
      ok: false,
      error: {
        type: 'GUARDRAIL_INPUT_TOO_LARGE',
        field: 'codebaseFiles',
        chars: codebaseChars,
        limit: MAX_CODEBASE_CHARS,
      },
    };
  }

  // 4. Prompt injection in file contents (first 5000 chars per file)
  for (const file of input.codebaseFiles) {
    if (detectPromptInjection(file.content.slice(0, 5_000))) {
      return {
        ok: false,
        error: {
          type: 'GUARDRAIL_PROMPT_INJECTION',
          field: `codebaseFiles[${file.filePath}]`,
        },
      };
    }
  }

  return { ok: true };
}

// ─── Output guardrails ────────────────────────────────────────────────────────

export interface PatchValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate that generated patches meet minimum quality criteria.
 * Blocks patches that delete entire lines or introduce path traversal.
 */
export function validatePatches(patches: FilePatch[]): PatchValidationResult {
  const errors: string[] = [];

  for (const patch of patches) {
    // No absolute paths in filePath
    if (patch.filePath.startsWith('/') || patch.filePath.includes('..')) {
      errors.push(`Patch has unsafe filePath: ${patch.filePath}`);
    }

    // patchedLine must not be empty (would delete the line entirely)
    if (patch.patchedLine.trim() === '') {
      errors.push(
        `Patch at ${patch.filePath}:${patch.lineNumber} produces empty line — use a comment to suppress if intentional`,
      );
    }

    // originalLine must not be empty (no spurious insertions)
    if (patch.originalLine.trim() === '') {
      errors.push(`Patch at ${patch.filePath}:${patch.lineNumber} has empty originalLine`);
    }

    // Detect obvious prompt-injection in generated patch content
    if (
      detectPromptInjection(patch.patchedLine) ||
      detectPromptInjection(patch.explanation)
    ) {
      errors.push(`Patch at ${patch.filePath}:${patch.lineNumber} contains suspicious content`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate migration notes satisfy the success criteria:
 * - ≥1 changelog URL must appear in the markdown
 * - "## Migration Notes" heading must be present
 */
export function validateMigrationNotes(notes: MigrationNotes): PatchValidationResult {
  const errors: string[] = [];

  if (!notes.markdown.includes('## Migration Notes')) {
    errors.push('Migration notes missing "## Migration Notes" heading');
  }

  const hasUrl = notes.changelogUrls.some((url) => notes.markdown.includes(url));
  if (!hasUrl && notes.changelogUrls.length > 0) {
    errors.push('Migration notes do not cite any changelog URLs');
  }

  if (notes.changelogUrls.length === 0) {
    errors.push('Migration notes must cite at least one changelog URL');
  }

  return { valid: errors.length === 0, errors };
}
