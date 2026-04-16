/**
 * PR grouping strategies — matches Renovate's groupName config semantics.
 * Teams migrate in place without relearning the knob.
 */
import type { GroupingStrategy, RepoConfig } from "../../types.js";

export interface DepVersion {
  dep: string;
  fromVersion: string;
  toVersion: string;
}

export interface UpgradeGroup {
  groupId: string;
  label: string;
  deps: DepVersion[];
}

/**
 * Group a list of dependency upgrades according to the team's grouping strategy.
 * Returns a list of groups, each representing one PR.
 */
export function groupUpgrades(
  upgrades: DepVersion[],
  strategy: GroupingStrategy,
  repo: RepoConfig,
): UpgradeGroup[] {
  switch (strategy.kind) {
    case "per-dep":
      return groupPerDep(upgrades);

    case "per-family":
      return groupPerFamily(upgrades, strategy.pattern);

    case "per-release-window":
      // All upgrades in the window go into one consolidated PR
      return groupAllTogether(upgrades, `${repo.owner}/${repo.repo}`);
  }
}

function groupPerDep(upgrades: DepVersion[]): UpgradeGroup[] {
  return upgrades.map((u) => ({
    groupId: `${u.dep}@${u.toVersion}`,
    label: `${u.dep} ${u.fromVersion} → ${u.toVersion}`,
    deps: [u],
  }));
}

function groupPerFamily(upgrades: DepVersion[], pattern: string): UpgradeGroup[] {
  // Convert glob pattern to regex: @aws-sdk/* → /^@aws-sdk\//
  const familyRegex = globToRegex(pattern);
  const familyGroup: DepVersion[] = [];
  const soloGroups: UpgradeGroup[] = [];

  for (const u of upgrades) {
    if (familyRegex.test(u.dep)) {
      familyGroup.push(u);
    } else {
      soloGroups.push({
        groupId: `${u.dep}@${u.toVersion}`,
        label: `${u.dep} ${u.fromVersion} → ${u.toVersion}`,
        deps: [u],
      });
    }
  }

  const groups: UpgradeGroup[] = [...soloGroups];

  if (familyGroup.length > 0) {
    const versions = familyGroup.map((u) => u.toVersion);
    const uniqueVersions = [...new Set(versions)];
    const versionLabel = uniqueVersions.length === 1 ? uniqueVersions[0] : uniqueVersions.join(", ");
    groups.push({
      groupId: `family:${pattern}@${versionLabel}`,
      label: `${pattern} family upgrade (${familyGroup.length} packages)`,
      deps: familyGroup,
    });
  }

  return groups;
}

function groupAllTogether(upgrades: DepVersion[], repoLabel: string): UpgradeGroup[] {
  if (upgrades.length === 0) return [];
  return [
    {
      groupId: `window:${repoLabel}:${Date.now()}`,
      label: `Release window upgrade (${upgrades.length} packages)`,
      deps: upgrades,
    },
  ];
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars
    .replace(/\*/g, ".*"); // glob * → .*
  return new RegExp(`^${escaped}$`);
}

/** Filter out pinned-skip deps and deps already on the target version. */
export function filterEligibleUpgrades(
  upgrades: DepVersion[],
  pinnedSkipList: string[],
): DepVersion[] {
  return upgrades.filter(
    (u) =>
      !pinnedSkipList.includes(u.dep) && u.fromVersion !== u.toVersion,
  );
}
