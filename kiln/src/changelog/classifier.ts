import type { BreakingChange } from "./types.js";

/**
 * Domain allowlist for changelog URL fetching.
 * SSRF guard — only fetch from known-good domains.
 */
export const CHANGELOG_DOMAIN_ALLOWLIST = [
  "github.com",
  "raw.githubusercontent.com",
  "npmjs.com",
  "registry.npmjs.org",
  "aws.amazon.com",
  "docs.aws.amazon.com",
  "nextjs.org",
  "react.dev",
  "prisma.io",
  "typescriptlang.org",
] as const;

export type AllowedDomain = (typeof CHANGELOG_DOMAIN_ALLOWLIST)[number];

/**
 * Severity of a breaking change — used to triage whether Kiln can auto-patch.
 */
export type BreakingChangeSeverity = "auto-patchable" | "needs-human" | "informational";

export interface ClassifiedBreakingChange extends BreakingChange {
  severity: BreakingChangeSeverity;
  affectedApis: string[];
}

/**
 * Validate that a URL's hostname is in the domain allowlist.
 * Throws if the URL is not on the allowlist — SSRF guard.
 */
export function assertAllowedUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid changelog URL: ${rawUrl}`);
  }

  const hostname = url.hostname.replace(/^www\./, "");
  const allowed = CHANGELOG_DOMAIN_ALLOWLIST.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
  if (!allowed) {
    throw new Error(
      `Changelog URL hostname "${hostname}" is not on the allowlist. ` +
        `Allowed: ${CHANGELOG_DOMAIN_ALLOWLIST.join(", ")}`
    );
  }
  return url;
}

/**
 * Heuristic classification of a breaking change description.
 * In production this is augmented by Bedrock (Haiku) classification —
 * this function provides the fallback and the unit-testable layer.
 */
export function classifyBreakingChange(change: BreakingChange): ClassifiedBreakingChange {
  const desc = change.description.toLowerCase();

  // Patterns that suggest auto-patchable renames / import changes
  const autoPatterns = [
    /renamed?\s+(?:from\s+)?[`'"]\w/i,
    /import.*changed/i,
    /moved?\s+to\s+[`'"]/i,
    /replaced?\s+(?:with|by)\s+[`'"]/i,
    /deprecated.*use\s+[`'"]/i,
  ];

  // Patterns that require human judgment
  const humanPatterns = [
    /behavior\s+(?:has\s+)?changed/i,
    /semantic/i,
    /runtime\s+error/i,
    /breaking\s+if/i,
    /may\s+(?:cause|break)/i,
    /depends\s+on/i,
    /configuration\s+(?:format|schema)\s+changed/i,
  ];

  const severity: BreakingChangeSeverity = autoPatterns.some((p) => p.test(desc))
    ? "auto-patchable"
    : humanPatterns.some((p) => p.test(desc))
      ? "needs-human"
      : "informational";

  // Extract API surface identifiers (quoted symbols, PascalCase types, camelCase functions)
  const affectedApis = extractApiIdentifiers(change.description);

  return { ...change, severity, affectedApis };
}

function extractApiIdentifiers(text: string): string[] {
  const results = new Set<string>();

  // Backtick-quoted identifiers
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    results.add(m[1]);
  }
  // Single/double-quoted identifiers
  for (const m of text.matchAll(/['"]([A-Za-z][\w.]+)['"]/g)) {
    results.add(m[1]);
  }

  return [...results];
}

/**
 * Filter breaking changes to only those that reference identifiers
 * found in the scanned codebase usage set.
 */
export function filterRelevantBreakingChanges(
  changes: ClassifiedBreakingChange[],
  usedApis: Set<string>
): ClassifiedBreakingChange[] {
  if (usedApis.size === 0) return changes;
  return changes.filter(
    (c) =>
      c.affectedApis.length === 0 ||
      c.affectedApis.some((api) => usedApis.has(api) || [...usedApis].some((u) => u.includes(api)))
  );
}
