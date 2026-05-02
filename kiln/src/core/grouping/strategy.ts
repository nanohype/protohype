// Grouping strategy — matches Renovate's `groupName` semantics.
// A team configures one strategy; the poller uses it to decide which pending
// upgrades are consolidated into a single PR run.

import type { GroupingStrategy } from "../../types.js";

export interface PendingUpgrade {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  detectedAt: string; // ISO-8601
}

/**
 * Partition pending upgrades into groups. Each group becomes one PR run.
 */
export function groupUpgrades(
  strategy: GroupingStrategy,
  upgrades: PendingUpgrade[],
  now: Date,
): PendingUpgrade[][] {
  if (upgrades.length === 0) return [];
  switch (strategy.kind) {
    case "per-dep":
      return upgrades.map((u) => [u]);
    case "per-family":
      return groupByFamily(upgrades, strategy.pattern);
    case "per-release-window":
      return groupByWindow(upgrades, strategy.windowDays, now);
  }
}

function groupByFamily(upgrades: PendingUpgrade[], pattern: string): PendingUpgrade[][] {
  const matcher = toMatcher(pattern);
  const family: PendingUpgrade[] = [];
  const singles: PendingUpgrade[][] = [];
  for (const u of upgrades) {
    if (matcher(u.pkg)) family.push(u);
    else singles.push([u]);
  }
  return family.length > 0 ? [family, ...singles] : singles;
}

function groupByWindow(
  upgrades: PendingUpgrade[],
  windowDays: number,
  now: Date,
): PendingUpgrade[][] {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = upgrades.filter((u) => new Date(u.detectedAt).getTime() >= cutoff);
  const outOfWindow = upgrades.filter((u) => new Date(u.detectedAt).getTime() < cutoff);
  const groups: PendingUpgrade[][] = [];
  if (inWindow.length > 0) groups.push(inWindow);
  for (const u of outOfWindow) groups.push([u]);
  return groups;
}

/** Minimal glob: `*` = non-separator, `**` = anything. Good enough for "@aws-sdk/*". */
function toMatcher(pattern: string): (s: string) => boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`);
  return (s) => regex.test(s);
}
