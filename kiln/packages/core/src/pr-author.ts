import type { MigrationNote } from './types.js';

export interface PrCreateOptions {
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  /** Kebab-safe group name from UpgradeGroup.groupName. */
  groupName: string;
  migrationNotes: MigrationNote[];
}

export interface PrResult {
  prUrl: string;
  prNumber: number;
  branchName: string;
}

/**
 * Build the PR body from migration notes.
 * Pure function — no I/O, fully testable.
 *
 * Every PR body must include:
 * - At least one changelog URL per dependency
 * - Every breaking change named by file:line (or "flagged for human review")
 */
export function buildPrBody(notes: MigrationNote[]): string {
  const lines: string[] = [
    '## Migration Notes',
    '',
    '> Opened by [Kiln](https://github.com/apps/kiln) — dependency migration automation.',
    '> Review the patches below before merging.',
    '',
  ];

  for (const note of notes) {
    lines.push(
      `### \`${note.dependency}\` ${note.fromVersion} → ${note.toVersion}`,
      '',
      `**Changelog:** <${note.changelogUrl}>`,
      '',
    );

    if (note.breakingChanges.length === 0) {
      lines.push('_No breaking changes detected._', '');
    } else {
      lines.push('**Breaking Changes:**');
      for (const change of note.breakingChanges) {
        const badge = change.requiresHumanReview
          ? '⚠️ **human review required**'
          : '✅ mechanically patched';
        const loc =
          change.file && change.line
            ? ` — \`${change.file}:${change.line}\``
            : '';
        lines.push(`- ${badge}: ${change.description}${loc}`);
      }
      lines.push('');
    }

    if (note.patches.length > 0) {
      lines.push('**Patches Applied:**');
      for (const patch of note.patches) {
        lines.push(
          `- \`${patch.file}:${patch.originalLine}\``,
          `  - Before: \`${patch.originalCode}\``,
          `  - After:  \`${patch.patchedCode}\``,
        );
      }
      lines.push('');
    }

    if (note.humanReviewRequired) {
      lines.push(
        '> ⚠️ **One or more breaking changes require human judgment.**',
        '> Kiln could not produce a mechanical patch. See items marked above.',
        '',
      );
    }
  }

  return lines.join('\n');
}

/**
 * Build the PR branch name.
 * Always uses the `feat/kiln-` prefix so branch protection rules
 * can target a single pattern rather than enumerating every dep.
 */
export function buildBranchName(groupName: string, timestamp?: number): string {
  const ts = timestamp ?? Date.now();
  // Sanitise group name: lowercase, replace non-alphanumeric with dash
  const slug = groupName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `feat/kiln-${slug}-${ts}`;
}

/**
 * Build the PR title.
 */
export function buildPrTitle(notes: MigrationNote[]): string {
  if (notes.length === 1) {
    const note = notes[0]!;
    return `chore(deps): upgrade ${note.dependency} ${note.fromVersion} → ${note.toVersion} [kiln]`;
  }
  const names = notes.map((n) => `${n.dependency}@${n.toVersion}`).join(', ');
  return `chore(deps): upgrade ${names} [kiln]`;
}
