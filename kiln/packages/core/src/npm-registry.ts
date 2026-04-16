import { fetch } from 'undici';
import { TIMEOUTS } from './types.js';

export interface NpmPackageInfo {
  name: string;
  /** dist-tags.latest */
  latestVersion: string;
  versions: string[];
  /** Maps version string → ISO publish timestamp. */
  publishTimes: Record<string, string>;
  changelogUrl?: string;
}

interface NpmRegistryResponse {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, unknown>;
  time: Record<string, string>;
  repository?: { url?: string };
  bugs?: { url?: string };
  homepage?: string;
}

/**
 * Fetch package metadata from the npm registry.
 * Uses a 10 s timeout per TIMEOUTS.NPM_REGISTRY.
 */
export async function fetchPackageInfo(
  packageName: string,
  registryUrl = 'https://registry.npmjs.org',
): Promise<NpmPackageInfo> {
  // Encode scoped packages: @aws-sdk/client-s3 -> @aws-sdk%2Fclient-s3
  const encoded = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);

  const url = `${registryUrl}/${encoded}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUTS.NPM_REGISTRY),
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(
      `npm registry returned ${response.status} for package "${packageName}"`,
    );
  }

  const data = (await response.json()) as NpmRegistryResponse;

  const latestVersion = data['dist-tags']?.['latest'] ?? '';
  const versions = Object.keys(data.versions ?? {});
  const publishTimes: Record<string, string> = {};

  for (const [k, v] of Object.entries(data.time ?? {})) {
    if (k !== 'created' && k !== 'modified') {
      publishTimes[k] = v;
    }
  }

  // Best-effort changelog URL derivation from repository field
  const changelogUrl = deriveChangelogUrl(data);

  return { name: data.name, latestVersion, versions, publishTimes, changelogUrl };
}

/**
 * Derive a best-effort GitHub releases URL from package metadata.
 * Returns undefined if the repository is not on github.com.
 */
function deriveChangelogUrl(data: NpmRegistryResponse): string | undefined {
  const repoUrl = data.repository?.url ?? '';
  const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (match) {
    const slug = match[1]?.replace(/\.git$/, '') ?? '';
    return `https://github.com/${slug}/releases`;
  }
  return undefined;
}

/**
 * Check whether a new version is available for a package.
 * Returns null if the package is already at the latest version.
 */
export async function checkForUpdate(
  packageName: string,
  currentVersion: string,
  registryUrl?: string,
): Promise<{ latestVersion: string; changelogUrl?: string } | null> {
  const info = await fetchPackageInfo(packageName, registryUrl);
  if (!info.latestVersion || info.latestVersion === currentVersion) {
    return null;
  }
  return { latestVersion: info.latestVersion, changelogUrl: info.changelogUrl };
}
