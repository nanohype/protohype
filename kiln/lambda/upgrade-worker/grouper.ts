/**
 * PR grouping logic.
 *
 * Derives a `groupKey` string from a package name and the team's grouping strategy.
 * The groupKey is the stable identifier used as the DynamoDB PR ledger SK prefix,
 * the SQS MessageGroupId, and the GitHub branch name component.
 *
 * Grouping correctness requirement:
 *   - per-dep:            one PR per package — groupKey = package name (sanitised)
 *   - per-family:         one PR per matching family prefix — groupKey = family prefix
 *   - per-release-window: one PR per time window — groupKey = window start ISO date (day boundary)
 */
import type { GroupingStrategy } from '../shared/types';

/** Sanitise a string for use in a branch name / DynamoDB key. */
function sanitise(s: string): string {
  return s.replace(/[^a-z0-9._-]/gi, '-').replace(/-{2,}/g, '-').toLowerCase();
}

/**
 * Derive the group key for a given package name and grouping strategy.
 * Returns a stable, deterministic string.
 */
export function resolveGroupKey(packageName: string, grouping: GroupingStrategy): string {
  switch (grouping.strategy) {
    case 'per-dep':
      return sanitise(packageName);

    case 'per-family': {
      for (const prefix of grouping.families) {
        // Support glob-style prefix: "@aws-sdk/*" matches "@aws-sdk/client-foo"
        const stripped = prefix.replace(/\*$/, '');
        if (packageName.startsWith(stripped)) {
          return sanitise(stripped);
        }
      }
      // No family match — fall through to per-dep behaviour
      return sanitise(packageName);
    }

    case 'per-release-window': {
      // Bucket into windows based on wall-clock time
      const windowMs = grouping.windowHours * 60 * 60 * 1000;
      const now = Date.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      return `window-${new Date(windowStart).toISOString().replace(/[:.]/g, '-')}`;
    }
  }
}

/**
 * Given a list of packages that have new versions, group them by groupKey.
 * Returns a Map of groupKey → package names.
 */
export function groupPackages(
  packages: string[],
  grouping: GroupingStrategy,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const pkg of packages) {
    const key = resolveGroupKey(pkg, grouping);
    const existing = groups.get(key) ?? [];
    existing.push(pkg);
    groups.set(key, existing);
  }
  return groups;
}

/** Build a Kiln branch name from a group key and target version. */
export function buildBranchName(groupKey: string, toVersion: string): string {
  const safeVersion = toVersion.replace(/[^a-z0-9.-]/gi, '-');
  return `feat/kiln-${sanitise(groupKey)}-${safeVersion}`;
}
