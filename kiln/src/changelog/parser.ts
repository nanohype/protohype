import type { ChangelogEntry, ChangelogSection, BreakingChange } from "./types.js";

// Matches: ## [1.2.3] - 2024-01-15  OR  ## 1.2.3  OR  ## v1.2.3
const VERSION_HEADER_RE =
  /^##\s+\[?v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\]?(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?/;
const SECTION_HEADER_RE = /^###\s+(.+)/;
const BREAKING_SECTION_RE = /breaking[\s_-]?change/i;

// Conventional commit breaking indicator: feat!: or BREAKING CHANGE: in body
const CONVENTIONAL_BREAKING_INLINE_RE = /^[-*]\s+(?:\w+)!:\s+(.+)/;
const CONVENTIONAL_BREAKING_FOOTER_RE = /^BREAKING[- ]CHANGE[:\s]+(.+)/;

/**
 * Parse a CHANGELOG.md string (Keep-a-Changelog format) into structured entries.
 * Only entries between fromVersion (exclusive) and toVersion (inclusive) are returned.
 */
export function parseChangelog(
  markdown: string,
  fromVersion: string,
  toVersion: string
): { entries: ChangelogEntry[]; breakingChanges: BreakingChange[] } {
  const lines = markdown.split("\n");
  const entries: ChangelogEntry[] = [];
  const allBreaking: BreakingChange[] = [];

  let currentVersion: string | null = null;
  let currentDate: string | undefined;
  let currentSectionTitle: string | null = null;
  let currentSectionItems: string[] = [];
  let currentSections: ChangelogSection[] = [];
  let currentRawLines: string[] = [];
  let inRange = false;

  const flushSection = () => {
    if (currentSectionTitle !== null) {
      const isBreaking = BREAKING_SECTION_RE.test(currentSectionTitle);
      currentSections.push({
        title: currentSectionTitle,
        items: [...currentSectionItems],
        isBreaking,
      });
      currentSectionTitle = null;
      currentSectionItems = [];
    }
  };

  const flushEntry = () => {
    if (currentVersion === null) return;
    flushSection();
    const entry: ChangelogEntry = {
      version: currentVersion,
      date: currentDate,
      sections: [...currentSections],
      rawMarkdown: currentRawLines.join("\n").trim(),
    };
    entries.push(entry);

    // Extract breaking changes from this entry
    for (const section of entry.sections) {
      if (section.isBreaking) {
        for (const item of section.items) {
          allBreaking.push({ description: item });
        }
      }
    }
    // Also scan all items for conventional commit breaking indicators
    for (const section of entry.sections) {
      for (const item of section.items) {
        const inlineMatch = CONVENTIONAL_BREAKING_INLINE_RE.exec(item);
        if (inlineMatch) {
          allBreaking.push({ description: inlineMatch[1], conventionalCommit: item });
        }
        const footerMatch = CONVENTIONAL_BREAKING_FOOTER_RE.exec(item);
        if (footerMatch) {
          allBreaking.push({ description: footerMatch[1], conventionalCommit: item });
        }
      }
    }

    currentVersion = null;
    currentDate = undefined;
    currentSections = [];
    currentRawLines = [];
  };

  for (const line of lines) {
    const versionMatch = VERSION_HEADER_RE.exec(line);
    if (versionMatch) {
      flushEntry();
      const ver = versionMatch[1];
      const date = versionMatch[2];

      // Determine if this version is in the [fromVersion, toVersion] range.
      // We want versions > fromVersion and <= toVersion.
      // Simple string check: stop collecting once we see fromVersion.
      if (ver === fromVersion) {
        inRange = false;
      } else if (ver === toVersion) {
        inRange = true;
        currentVersion = ver;
        currentDate = date;
        currentRawLines = [line];
      } else if (inRange) {
        currentVersion = ver;
        currentDate = date;
        currentRawLines = [line];
      }
      continue;
    }

    if (currentVersion === null) continue;

    const sectionMatch = SECTION_HEADER_RE.exec(line);
    if (sectionMatch) {
      flushSection();
      currentSectionTitle = sectionMatch[1].trim();
      currentRawLines.push(line);
      continue;
    }

    currentRawLines.push(line);
    if (currentSectionTitle !== null && /^[-*]\s+/.test(line)) {
      currentSectionItems.push(line.replace(/^[-*]\s+/, "").trim());
    }
  }

  flushEntry();

  return { entries, breakingChanges: allBreaking };
}

/**
 * Extract the raw changelog block for a single version from a larger changelog string.
 */
export function extractVersionBlock(markdown: string, version: string): string | null {
  const lines = markdown.split("\n");
  let capturing = false;
  const block: string[] = [];

  for (const line of lines) {
    const m = VERSION_HEADER_RE.exec(line);
    if (m) {
      if (m[1] === version) {
        capturing = true;
        block.push(line);
        continue;
      } else if (capturing) {
        break;
      }
    }
    if (capturing) block.push(line);
  }

  return block.length > 0 ? block.join("\n").trim() : null;
}

/**
 * List all versions present in a CHANGELOG.md string, in document order (newest first).
 */
export function listVersions(markdown: string): string[] {
  const versions: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = VERSION_HEADER_RE.exec(line);
    if (m) versions.push(m[1]);
  }
  return versions;
}
