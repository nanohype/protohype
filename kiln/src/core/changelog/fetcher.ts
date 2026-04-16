/**
 * Vendor changelog fetcher.
 * Strict domain allowlist — arbitrary URLs rejected to prevent SSRF.
 * All fetches have explicit per-call timeouts.
 */
import { config } from "../../config.js";
import { log } from "../../telemetry/otel.js";

export class ChangelogFetchError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(`Changelog fetch failed for ${url}: ${reason}`);
    this.name = "ChangelogFetchError";
  }
}

export class BlockedDomainError extends Error {
  constructor(public readonly url: string, public readonly domain: string) {
    super(`Changelog URL blocked — domain not in allowlist: ${domain} (url: ${url})`);
    this.name = "BlockedDomainError";
  }
}

function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    throw new ChangelogFetchError(rawUrl, "Invalid URL");
  }
}

function assertAllowedDomain(url: string): void {
  const hostname = extractDomain(url);
  const allowed = config.changelog.allowedDomains as readonly string[];
  if (!allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
    throw new BlockedDomainError(url, hostname);
  }
}

/**
 * Fetch raw changelog content from an allowed domain.
 * Returns null if the URL 404s (changelog may not exist for every release).
 */
export async function fetchChangelog(url: string): Promise<string | null> {
  assertAllowedDomain(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.changelog.fetchTimeoutMs);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "kiln-upgrade-bot/0.1.0" },
    });

    if (resp.status === 404) return null;

    if (!resp.ok) {
      throw new ChangelogFetchError(url, `HTTP ${resp.status}`);
    }

    return await resp.text();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new ChangelogFetchError(url, `Timeout after ${config.changelog.fetchTimeoutMs}ms`);
    }
    if (err instanceof ChangelogFetchError || err instanceof BlockedDomainError) {
      throw err;
    }
    throw new ChangelogFetchError(url, String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build changelog URLs for a given npm package and version.
 * Tries GitHub releases (most reliable), then npmjs.com changelog page.
 */
export async function resolveChangelogUrls(
  dep: string,
  toVersion: string,
): Promise<string[]> {
  const urls: string[] = [];

  // Try npm registry metadata to find repository URL
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.npm.timeoutMs);
    const resp = await fetch(`${config.npm.registryUrl}/${encodeURIComponent(dep)}/${toVersion}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (resp.ok) {
      const meta = (await resp.json()) as {
        repository?: { url?: string };
        bugs?: { url?: string };
      };
      const repoUrl = meta.repository?.url ?? "";
      const ghMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (ghMatch) {
        const [, owner, repoName] = ghMatch;
        urls.push(
          `https://github.com/${owner}/${repoName}/releases/tag/v${toVersion}`,
          `https://github.com/${owner}/${repoName}/blob/main/CHANGELOG.md`,
        );
      }
    }
  } catch (err) {
    log("warn", "Failed to resolve changelog URLs from npm registry", { dep, toVersion, err: String(err) });
  }

  // Always include the npm page as a fallback
  urls.push(`https://www.npmjs.com/package/${dep}/v/${toVersion}`);

  return urls;
}
