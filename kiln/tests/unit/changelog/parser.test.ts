import { describe, expect, it } from "vitest";
import {
  extractRangeSections,
  extractVersionSection,
  parseChangelog,
} from "../../../src/core/changelog/parser.js";

const RAW = `# Changelog

## [2.0.0] - 2026-03-01
### Breaking
- Removed \`legacyFn()\`.
- Renamed \`foo\` → \`bar\`.

## [1.1.0] - 2026-01-15
### Added
- \`newThing()\`.

## 1.0.0 - 2025-12-01
Initial release.
`;

describe("changelog parser", () => {
  it("parses all version sections", () => {
    const sections = parseChangelog(RAW);
    expect(sections.map((s) => s.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
    expect(sections[0]?.date).toBe("2026-03-01");
  });

  it("extracts a specific version", () => {
    const section = extractVersionSection(RAW, "1.1.0");
    expect(section?.body).toContain("newThing");
  });

  it("returns null for unknown version", () => {
    expect(extractVersionSection(RAW, "9.9.9")).toBeNull();
  });

  it("extracts range from newer to older (inclusive)", () => {
    const sections = extractRangeSections(RAW, "1.0.0", "2.0.0");
    // Changelogs are newest-first. Range 2.0.0 → 1.0.0 means entries (2.0.0, 1.1.0).
    expect(sections.map((s) => s.version)).toEqual(["2.0.0", "1.1.0"]);
  });
});
