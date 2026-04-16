import { fetch } from 'undici';
import { TIMEOUTS } from './types.js';

/**
 * Explicit domain allowlist — no arbitrary URLs accepted.
 * Prevents SSRF via crafted changelog redirects.
 */
export const DOMAIN_ALLOWLIST = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'api.github.com',
  'npmjs.com',
  'registry.npmjs.org',
  'cdn.npmjs.com',
  'aws.amazon.com',
  'docs.aws.amazon.com',
  'boto3.amazonaws.com',
  'react.dev',
  'reactjs.org',
  'nextjs.org',
  'prisma.io',
  'www.prisma.io',
  'typescriptlang.org',
  'www.typescriptlang.org',
]);

/**
 * Check whether a URL's hostname is in the domain allowlist.
 * Subdomain matching is supported (e.g. docs.github.com passes for github.com).
 */
export function isDomainAllowed(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  if (DOMAIN_ALLOWLIST.has(hostname)) return true;
  for (const allowed of DOMAIN_ALLOWLIST) {
    if (hostname.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

/**
 * Fetch changelog text from a vendor URL.
 *
 * Security rules:
 * - URL must be in DOMAIN_ALLOWLIST.
 * - Redirects are followed only if the target is also allowlisted.
 * - Timeout: TIMEOUTS.CHANGELOG_FETCH (10 s).
 */
export async function fetchChangelog(
  url: string,
  maxRedirects = 3,
): Promise<string> {
  if (!isDomainAllowed(url)) {
    throw new Error(
      `SSRF protection: domain not in allowlist for URL: ${url}`,
    );
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUTS.CHANGELOG_FETCH),
    redirect: 'manual',
  });

  // Follow redirects manually so we can validate each hop
  if (response.status >= 300 && response.status < 400) {
    if (maxRedirects <= 0) {
      throw new Error(`Too many redirects fetching changelog: ${url}`);
    }
    const location = response.headers.get('location') ?? '';
    if (!isDomainAllowed(location)) {
      throw new Error(
        `SSRF protection: redirect target not in allowlist: ${location}`,
      );
    }
    return fetchChangelog(location, maxRedirects - 1);
  }

  if (!response.ok) {
    throw new Error(
      `Changelog fetch failed: HTTP ${response.status} for ${url}`,
    );
  }

  return response.text();
}
