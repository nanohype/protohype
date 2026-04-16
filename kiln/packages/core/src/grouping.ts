import type {
  DepVersion,
  GroupingStrategy,
  TeamConfig,
  UpgradeGroup,
} from './types.js';

type GroupingConfig = Pick<TeamConfig, 'groupingStrategy' | 'groupingFamilies'>;

/**
 * Group a list of pending dependency upgrades according to the team's
 * configured grouping strategy.
 *
 * Matches Renovate's `groupName` semantics so teams migrating from Renovate
 * don't need to relearn the knob.
 *
 * Strategies:
 * - per-dep          → one group (= one PR) per dependency
 * - per-family       → deps matching a regex share a group; unmatched fall back to per-dep
 * - per-release-window → all deps in one group, named by today's date
 */
export function groupDependencies(
  deps: DepVersion[],
  teamId: string,
  repoFullName: string,
  config: GroupingConfig,
): UpgradeGroup[] {
  switch (config.groupingStrategy) {
    case 'per-dep':
      return deps.map((dep) => ({
        groupName: dep.name,
        dependencies: [dep],
        strategy: 'per-dep' as const,
        teamId,
        repoFullName,
      }));

    case 'per-family':
      return groupByFamily(deps, teamId, repoFullName, config.groupingFamilies);

    case 'per-release-window':
      return [
        {
          groupName: `release-window-${todayIso()}`,
          dependencies: deps,
          strategy: 'per-release-window' as const,
          teamId,
          repoFullName,
        },
      ];

    default: {
      const exhaustive: never = config.groupingStrategy;
      throw new Error(`Unknown grouping strategy: ${exhaustive}`);
    }
  }
}

function groupByFamily(
  deps: DepVersion[],
  teamId: string,
  repoFullName: string,
  families: Record<string, string>,
): UpgradeGroup[] {
  const grouped = new Map<string, DepVersion[]>();
  const unmatched: DepVersion[] = [];

  for (const dep of deps) {
    const groupName = findFamilyGroup(dep.name, families);
    if (groupName !== null) {
      let bucket = grouped.get(groupName);
      if (!bucket) {
        bucket = [];
        grouped.set(groupName, bucket);
      }
      bucket.push(dep);
    } else {
      unmatched.push(dep);
    }
  }

  const result: UpgradeGroup[] = [];

  for (const [groupName, groupDeps] of grouped) {
    result.push({
      groupName,
      dependencies: groupDeps,
      strategy: 'per-family',
      teamId,
      repoFullName,
    });
  }

  // Unmatched deps fall back to per-dep grouping
  for (const dep of unmatched) {
    result.push({
      groupName: dep.name,
      dependencies: [dep],
      strategy: 'per-dep',
      teamId,
      repoFullName,
    });
  }

  return result;
}

/**
 * Find the first family group name whose pattern matches depName.
 * Returns null if no pattern matches.
 */
export function findFamilyGroup(
  depName: string,
  families: Record<string, string>,
): string | null {
  for (const [pattern, groupName] of Object.entries(families)) {
    try {
      if (new RegExp(pattern).test(depName)) return groupName;
    } catch {
      // ignore malformed patterns
    }
  }
  return null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
