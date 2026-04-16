/**
 * GitHub PR author.
 *
 * Builds the Migration Notes PR body and opens the PR via the GitHub App.
 * All commits are authored through the App installation — Verified badge on GitHub.
 * Kiln never writes to main or protected branches.
 */
import type { MigrationResult, BreakingChange } from '../shared/types';
import { createPullRequest } from '../shared/github-app';

export interface PrAuthorParams {
  token: string;
  owner: string;
  repo: string;
  head: string;    // feat/kiln-... branch
  base: string;    // default branch
  packageName: string;
  fromVersion: string;
  toVersion: string;
  changelogUrls: string[];
  migrations: MigrationResult[];
}

/** Build the Migration Notes section for the PR body. */
export function buildMigrationNotes(params: {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  changelogUrls: string[];
  migrations: MigrationResult[];
}): string {
  const lines: string[] = [];

  lines.push(`## 🔥 Kiln Migration Notes`);
  lines.push('');
  lines.push(`Upgrading **${params.packageName}** from \`${params.fromVersion}\` → \`${params.toVersion}\``);
  lines.push('');

  if (params.changelogUrls.length > 0) {
    lines.push('### Changelog references');
    for (const url of params.changelogUrls) {
      lines.push(`- ${url}`);
    }
    lines.push('');
  }

  const patched = params.migrations.filter((m): m is Extract<MigrationResult, { kind: 'patched' }> => m.kind === 'patched');
  const humanReview = params.migrations.filter((m): m is Extract<MigrationResult, { kind: 'human-review' }> => m.kind === 'human-review');
  const noUsage = params.migrations.filter((m): m is Extract<MigrationResult, { kind: 'no-usage' }> => m.kind === 'no-usage');

  if (patched.length > 0) {
    lines.push('### ✅ Mechanically patched');
    lines.push('Kiln applied these changes automatically:');
    lines.push('');
    for (const m of patched) {
      lines.push(`#### ${m.change.description}`);
      if (m.change.sourceUrl) lines.push(`> Source: ${m.change.sourceUrl}`);
      lines.push('');
      for (const patch of m.patches) {
        lines.push(`- **${patch.file}** lines ${patch.startLine}–${patch.endLine}`);
      }
      lines.push('');
    }
  }

  if (humanReview.length > 0) {
    lines.push('### ⚠️ Needs human judgment');
    lines.push('Kiln could not mechanically patch these — human review required before merging:');
    lines.push('');
    for (const m of humanReview) {
      lines.push(`#### ${m.change.description}`);
      if (m.change.sourceUrl) lines.push(`> Source: ${m.change.sourceUrl}`);
      lines.push('');
      lines.push(`**Why Kiln could not patch this:** ${m.reason}`);
      if (m.usages.length > 0) {
        lines.push('');
        lines.push('**Usage sites that need attention:**');
        for (const u of m.usages) {
          const lineRange = u.lines.length > 1
            ? `lines ${u.lines[0]}–${u.lines[u.lines.length - 1]}`
            : `line ${u.lines[0]}`;
          lines.push(`- \`${u.file}\` ${lineRange}`);
        }
      }
      lines.push('');
    }
  }

  if (noUsage.length > 0) {
    lines.push('### ℹ️ No usage found');
    lines.push('These breaking changes do not affect this repo (no matching usage sites):');
    lines.push('');
    for (const m of noUsage) {
      lines.push(`- ${m.change.description}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*This PR was opened by [Kiln](https://github.com/apps/kiln-app). Review the patched changes and merge when satisfied.*');

  return lines.join('\n');
}

/** Summarise breaking changes for the PR title. */
function buildPrTitle(packageName: string, fromVersion: string, toVersion: string, migrations: MigrationResult[]): string {
  const patchedCount = migrations.filter((m) => m.kind === 'patched').length;
  const reviewCount = migrations.filter((m) => m.kind === 'human-review').length;

  if (patchedCount === 0 && reviewCount === 0) {
    return `chore(deps): upgrade ${packageName} ${fromVersion} → ${toVersion}`;
  }

  const parts: string[] = [];
  if (patchedCount > 0) parts.push(`${patchedCount} auto-patched`);
  if (reviewCount > 0) parts.push(`${reviewCount} needs review`);

  return `chore(deps): upgrade ${packageName} ${fromVersion} → ${toVersion} [${parts.join(', ')}]`;
}

/** Collect all unique changelog URLs from migration results plus the primary one. */
function collectChangelogUrls(primary: string[], migrations: MigrationResult[]): string[] {
  const urls = new Set(primary);
  for (const m of migrations) {
    if ('change' in m && m.change.sourceUrl) urls.add(m.change.sourceUrl);
  }
  return [...urls];
}

/** Open the Kiln PR. Returns the PR number and URL. */
export async function openKilnPr(params: PrAuthorParams): Promise<{ number: number; url: string }> {
  const allChangelogUrls = collectChangelogUrls(params.changelogUrls, params.migrations);

  const body = buildMigrationNotes({
    packageName: params.packageName,
    fromVersion: params.fromVersion,
    toVersion: params.toVersion,
    changelogUrls: allChangelogUrls,
    migrations: params.migrations,
  });

  const title = buildPrTitle(
    params.packageName,
    params.fromVersion,
    params.toVersion,
    params.migrations,
  );

  const pr = await createPullRequest({
    token: params.token,
    owner: params.owner,
    repo: params.repo,
    title,
    body,
    head: params.head,
    base: params.base,
  });

  return { number: pr.number, url: pr.html_url };
}

/** Build a consolidated PR body for a per-family or per-window group of packages. */
export function buildConsolidatedPrBody(params: {
  packageUpdates: Array<{
    packageName: string;
    fromVersion: string;
    toVersion: string;
    changelogUrls: string[];
    migrations: MigrationResult[];
  }>;
  groupKey: string;
}): string {
  const lines: string[] = [];
  lines.push(`## 🔥 Kiln Consolidated Upgrade — group: \`${params.groupKey}\``);
  lines.push('');

  for (const update of params.packageUpdates) {
    lines.push(`### ${update.packageName} \`${update.fromVersion}\` → \`${update.toVersion}\``);
    lines.push('');

    const notes = buildMigrationNotes({
      packageName: update.packageName,
      fromVersion: update.fromVersion,
      toVersion: update.toVersion,
      changelogUrls: update.changelogUrls,
      migrations: update.migrations,
    });

    // Indent the sub-section (skip the "## 🔥 Kiln Migration Notes" header)
    const subLines = notes.split('\n').slice(1);
    lines.push(...subLines);
    lines.push('');
  }

  lines.push('---');
  lines.push('*This PR was opened by [Kiln](https://github.com/apps/kiln-app).*');
  return lines.join('\n');
}

/** Collect all unique changelog URLs from breaking changes (for requirement: ≥1 per PR). */
export function collectAllChangelogUrls(migrations: MigrationResult[]): string[] {
  const urls = new Set<string>();
  for (const m of migrations) {
    if ('change' in m && m.change.sourceUrl) urls.add(m.change.sourceUrl);
  }
  return [...urls];
}

/** Collect all breaking changes cited in Migration Notes (for requirement: named by file:line). */
export function collectAllBreakingChangeCitations(migrations: MigrationResult[]): Array<{
  description: string;
  file: string;
  lines: number[];
}> {
  const citations: Array<{ description: string; file: string; lines: number[] }> = [];
  for (const m of migrations) {
    if (m.kind === 'patched') {
      for (const patch of m.patches) {
        citations.push({
          description: m.change.description,
          file: patch.file,
          lines: [patch.startLine, patch.endLine],
        });
      }
    } else if (m.kind === 'human-review') {
      for (const usage of m.usages) {
        citations.push({
          description: m.change.description,
          file: usage.file,
          lines: usage.lines,
        });
      }
    }
  }
  return citations;
}
