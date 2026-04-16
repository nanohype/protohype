/**
 * Changelog parser — extracts version-specific content from raw changelog text.
 * Used to isolate the relevant section before sending to Bedrock for classification.
 */

/**
 * Extract the changelog section relevant to a specific version transition.
 * Handles common formats: Keep a Changelog, GitHub Releases markdown, simple headers.
 */
export function extractVersionSection(
  rawChangelog: string,
  fromVersion: string,
  toVersion: string,
): string {
  // Normalize version strings (strip leading 'v')
  const normalizeV = (v: string) => v.replace(/^v/, "");
  const to = normalizeV(toVersion);
  const from = normalizeV(fromVersion);

  // Split on heading patterns that look like version headers
  const lines = rawChangelog.split("\n");

  let capturing = false;
  let section: string[] = [];

  for (const line of lines) {
    // Match version headers: ## [1.2.3], ## v1.2.3, # 1.2.3, ### 1.2.3
    const headerMatch = line.match(/^#{1,3}\s+\[?v?([\d.]+)/);

    if (headerMatch) {
      const headerVer = headerMatch[1];

      if (headerVer === to) {
        capturing = true;
        section = [line];
        continue;
      }

      if (capturing && headerVer === from) {
        // Reached the from-version section — stop
        break;
      }

      if (capturing && headerVer !== to) {
        // Hit another version header we don't care about — stop if below from
        const [toMaj, toMin] = to.split(".").map(Number);
        const [hMaj, hMin] = headerVer.split(".").map(Number);
        if ((hMaj ?? 0) < (toMaj ?? 0) || ((hMaj ?? 0) === (toMaj ?? 0) && (hMin ?? 0) < (toMin ?? 0))) {
          break;
        }
      }
    }

    if (capturing) {
      section.push(line);
    }
  }

  const result = section.join("\n").trim();

  // If we couldn't isolate a section, return first 8000 chars of raw content
  return result.length > 0 ? result.slice(0, 16_000) : rawChangelog.slice(0, 8_000);
}

/**
 * Detect if the changelog section mentions breaking changes.
 * Fast heuristic check before sending to Bedrock — saves Haiku calls on patch-only releases.
 */
export function hasPotentialBreakingChanges(changelogSection: string): boolean {
  const patterns = [
    /breaking\s+change/i,
    /\bBREAKING\b/,
    /removed?\s+(api|method|function|export|class|interface|type)/i,
    /deprecated.*removed/i,
    /no\s+longer\s+supported/i,
    /migration\s+(required|guide|needed)/i,
    /incompatible/i,
    /\bMIGRAT/i,
  ];
  return patterns.some((p) => p.test(changelogSection));
}
