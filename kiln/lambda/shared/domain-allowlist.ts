/**
 * Domain allowlist for vendor changelog fetches.
 *
 * Arbitrary URLs are rejected at ingest to prevent SSRF via crafted
 * changelog redirects.  Only the explicitly named domains are permitted.
 *
 * Redirects to a different host are also validated against this list.
 */

const ALLOWED_HOSTNAMES = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'api.github.com',
  'npmjs.com',
  'registry.npmjs.org',
  'www.npmjs.com',
  'aws.amazon.com',
  'docs.aws.amazon.com',
  'github.blog',
  'react.dev',
  'nextjs.org',
  'www.prisma.io',
  'prisma.io',
  'www.typescriptlang.org',
  'typescriptlang.org',
  'babeljs.io',
  'webpack.js.org',
  'vitejs.dev',
  'eslint.org',
  'prettier.io',
  'jestjs.io',
  'vitest.dev',
  'nodejs.org',
]);

export class DomainNotAllowed extends Error {
  constructor(public readonly hostname: string) {
    super(`Changelog fetch rejected: domain '${hostname}' is not in the allowlist.`);
    this.name = 'DomainNotAllowed';
  }
}

/** Validate a URL against the allowlist. Throws DomainNotAllowed if rejected. */
export function validateChangelogUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new DomainNotAllowed(parsed.hostname);
  }

  const host = parsed.hostname.toLowerCase();

  // Check exact match or *.subdomain match
  if (ALLOWED_HOSTNAMES.has(host)) return parsed;

  // Allow subdomains of allowed hosts (e.g. docs.github.com → github.com)
  for (const allowed of ALLOWED_HOSTNAMES) {
    if (host.endsWith(`.${allowed}`)) return parsed;
  }

  throw new DomainNotAllowed(host);
}

/** Exposed for testing. Returns the full allowlist. */
export function getAllowedHostnames(): ReadonlySet<string> {
  return ALLOWED_HOSTNAMES;
}
