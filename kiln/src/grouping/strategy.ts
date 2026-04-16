import type { DepUpdate, GroupingStrategy, PrGroup } from "./types.js";

/**
 * Group a batch of dependency updates according to the team's configured strategy.
 *
 * Invariants:
 * - per-dep: exactly one PrGroup per DepUpdate (N updates → N groups)
 * - per-family: updates whose packageName matches the glob prefix are consolidated;
 *               unmatched updates each get their own group
 * - per-release-window: all updates published within the same N-day window bucket
 *                        are consolidated into one group
 */
export function groupUpdates(
  updates: DepUpdate[],
  strategy: GroupingStrategy
): PrGroup[] {
  if (updates.length === 0) return [];

  switch (strategy.type) {
    case "per-dep":
      return groupPerDep(updates);

    case "per-family":
      return groupPerFamily(updates, strategy.pattern);

    case "per-release-window":
      return groupPerReleaseWindow(updates, strategy.windowDays);
  }
}

function groupPerDep(updates: DepUpdate[]): PrGroup[] {
  return updates.map((u) => ({
    groupId: slugify(`${u.packageName}@${u.toVersion}`),
    label: `${u.packageName} → ${u.toVersion}`,
    updates: [u],
  }));
}

function groupPerFamily(updates: DepUpdate[], pattern: string): PrGroup[] {
  // Convert glob-style "@aws-sdk/*" into a prefix: "@aws-sdk/"
  const prefix = pattern.endsWith("/*")
    ? pattern.slice(0, -1) // strip the trailing *
    : pattern + "/";

  const familyUpdates: DepUpdate[] = [];
  const soloUpdates: DepUpdate[] = [];

  for (const u of updates) {
    if (u.packageName.startsWith(prefix) || matchesGlob(u.packageName, pattern)) {
      familyUpdates.push(u);
    } else {
      soloUpdates.push(u);
    }
  }

  const groups: PrGroup[] = [];

  if (familyUpdates.length > 0) {
    const familyLabel = pattern.replace("/*", "");
    // Use the highest toVersion among family members as the version label
    const maxVersion = familyUpdates
      .map((u) => u.toVersion)
      .sort()
      .at(-1)!;
    groups.push({
      groupId: slugify(`family-${familyLabel}@${maxVersion}`),
      label: `${familyLabel} family → ${maxVersion}`,
      updates: familyUpdates,
    });
  }

  // Solo updates each get their own group
  for (const u of soloUpdates) {
    groups.push({
      groupId: slugify(`${u.packageName}@${u.toVersion}`),
      label: `${u.packageName} → ${u.toVersion}`,
      updates: [u],
    });
  }

  return groups;
}

function groupPerReleaseWindow(updates: DepUpdate[], windowDays: number): PrGroup[] {
  if (windowDays <= 0) throw new Error("windowDays must be a positive integer");

  // Bucket updates by their publishedAt window (epoch_days / windowDays)
  const buckets = new Map<number, DepUpdate[]>();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  for (const u of updates) {
    const ts = new Date(u.publishedAt).getTime();
    if (isNaN(ts)) throw new Error(`Invalid publishedAt timestamp: ${u.publishedAt}`);
    const bucket = Math.floor(ts / windowMs);
    const existing = buckets.get(bucket) ?? [];
    existing.push(u);
    buckets.set(bucket, existing);
  }

  const groups: PrGroup[] = [];
  for (const [bucket, bucketUpdates] of [...buckets.entries()].sort(([a], [b]) => a - b)) {
    const windowStart = new Date(bucket * windowMs).toISOString().slice(0, 10);
    groups.push({
      groupId: slugify(`window-${windowStart}`),
      label: `Release window ${windowStart}`,
      updates: bucketUpdates,
    });
  }

  return groups;
}

/** Simple glob match — only supports trailing /* wildcard */
function matchesGlob(name: string, pattern: string): boolean {
  if (pattern.endsWith("/*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9@._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
