/**
 * npm registry client.
 * Polls the npm registry for the latest version of a package.
 * Respects the team's target-version policy.
 * Per-call timeout: 10 seconds (registry).
 */
import type { TargetVersionPolicy, WatchedPackage } from '../shared/types';

const REGISTRY_BASE = 'https://registry.npmjs.org';

interface NpmPackageMetadata {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, {
    version: string;
    deprecated?: string;
    repository?: { url?: string };
  }>;
  time: Record<string, string>;
}

export interface PackageVersionInfo {
  packageName: string;
  latestVersion: string;
  publishedAt: string;
  changelogUrl: string;
}

function parseSemanticVersion(v: string): [number, number, number] {
  const parts = v.replace(/^[^0-9]*/, '').split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function pickTargetVersion(
  allVersions: string[],
  currentVersion: string,
  policy: TargetVersionPolicy,
  skipVersions: string[],
): string | null {
  const current = parseSemanticVersion(currentVersion);
  const candidates = allVersions
    .filter((v) => !skipVersions.includes(v))
    .filter((v) => {
      const [maj, min] = parseSemanticVersion(v);
      if (policy === 'latest') return true;
      if (policy === 'next-minor') return maj === current[0];
      if (policy === 'next-patch') return maj === current[0] && min === current[1];
      return true;
    })
    .sort((a, b) => {
      const [aMaj, aMin, aPatch] = parseSemanticVersion(a);
      const [bMaj, bMin, bPatch] = parseSemanticVersion(b);
      if (bMaj !== aMaj) return bMaj - aMaj;
      if (bMin !== aMin) return bMin - aMin;
      return bPatch - aPatch;
    });
  return candidates[0] ?? null;
}

/** Derive a changelog URL from npm package metadata. */
function deriveChangelogUrl(meta: NpmPackageMetadata, version: string): string {
  // Prefer GitHub releases URL if repository is on github.com
  const repoUrl = meta.versions[version]?.repository?.url ?? '';
  const ghMatch = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?/);
  if (ghMatch) {
    return `https://github.com/${ghMatch[1]}/releases/tag/v${version}`;
  }
  // Fall back to npmjs.com package page
  return `https://www.npmjs.com/package/${meta.name}/v/${version}`;
}

/**
 * Fetch the current latest version of a package from the npm registry.
 * Returns null if the package already matches `currentVersion` (no upgrade needed).
 */
export async function fetchLatestVersion(
  pkg: WatchedPackage,
  currentVersion: string,
): Promise<PackageVersionInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);  // 10s registry timeout

  try {
    const resp = await fetch(`${REGISTRY_BASE}/${encodeURIComponent(pkg.name)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!resp.ok) throw new Error(`npm registry ${resp.status} for ${pkg.name}`);

    const meta = (await resp.json()) as NpmPackageMetadata;
    const allVersions = Object.keys(meta.versions ?? {});
    const target = pickTargetVersion(
      allVersions,
      currentVersion,
      pkg.policy,
      pkg.skipVersions ?? [],
    );

    if (!target || target === currentVersion) return null;

    // Compare: only return if target > current
    const [tMaj, tMin, tPatch] = parseSemanticVersion(target);
    const [cMaj, cMin, cPatch] = parseSemanticVersion(currentVersion);
    const isNewer =
      tMaj > cMaj ||
      (tMaj === cMaj && tMin > cMin) ||
      (tMaj === cMaj && tMin === cMin && tPatch > cPatch);

    if (!isNewer) return null;

    const publishedAt = meta.time[target] ?? new Date().toISOString();
    const changelogUrl = deriveChangelogUrl(meta, target);

    return { packageName: pkg.name, latestVersion: target, publishedAt, changelogUrl };
  } finally {
    clearTimeout(timeout);
  }
}
