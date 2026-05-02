// Changelog source allowlist — SSRF prevention.
// Any URL outside this list is rejected before an HTTP request is ever made.
// Adding a host here is a security-review event; don't expand casually.

const ALLOWED_HOSTS = new Set<string>([
  "github.com",
  "raw.githubusercontent.com",
  "api.github.com",
  "registry.npmjs.org",
  "www.npmjs.com",
]);

export function isChangelogHostAllowed(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_HOSTS.has(url.hostname);
}

export function allowedHosts(): readonly string[] {
  return [...ALLOWED_HOSTS];
}
