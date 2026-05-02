// Pure changelog parser. Extracts the section for a specific version from a
// markdown-ish changelog (handles "## [1.2.3]", "## 1.2.3", "## v1.2.3" and
// "# 1.2.3" variants). No I/O.

export interface ChangelogSection {
  version: string;
  date?: string;
  body: string;
}

const HEADER = /^(#{1,3})\s+v?\[?(\d+\.\d+\.\d+(?:-[\w.]+)?)\]?\s*(?:-\s*(\d{4}-\d{2}-\d{2}))?/;

export function parseChangelog(raw: string): ChangelogSection[] {
  const lines = raw.split("\n");
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;

  for (const line of lines) {
    const match = HEADER.exec(line);
    if (match) {
      if (current) sections.push(current);
      const version = match[2];
      if (!version) {
        current = null;
        continue;
      }
      const date = match[3];
      current = date ? { version, date, body: "" } : { version, body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) sections.push(current);

  return sections.map((s) => ({ ...s, body: s.body.trim() }));
}

export function extractVersionSection(raw: string, version: string): ChangelogSection | null {
  return parseChangelog(raw).find((s) => s.version === version) ?? null;
}

export function extractRangeSections(
  raw: string,
  fromVersion: string,
  toVersion: string,
): ChangelogSection[] {
  const sections = parseChangelog(raw);
  const fromIdx = sections.findIndex((s) => s.version === fromVersion);
  const toIdx = sections.findIndex((s) => s.version === toVersion);
  if (toIdx === -1) return [];
  // Changelogs are typically newest-first. Range = (toIdx .. fromIdx), toIdx inclusive.
  const end = fromIdx === -1 ? sections.length : fromIdx;
  return sections.slice(toIdx, end);
}
