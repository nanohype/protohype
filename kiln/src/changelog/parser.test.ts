import { describe, it, expect } from "vitest";
import { parseChangelog, extractVersionBlock, listVersions } from "./parser.js";

const SAMPLE_CHANGELOG = `# Changelog

## [3.0.0] - 2024-03-01

### Breaking Changes

- Renamed \`createClient\` to \`buildClient\`
- Removed deprecated \`legacyMode\` option

### Features

- Added \`withRetry\` helper

## [2.5.0] - 2024-01-15

### Added

- New \`batch\` API surface

### Breaking Changes

- feat!: \`connect()\` now returns a Promise instead of void

## [2.4.0] - 2024-01-01

### Fixed

- Corrected timeout handling
`;

describe("parseChangelog", () => {
  it("extracts entries within the version range (inclusive toVersion)", () => {
    const { entries } = parseChangelog(SAMPLE_CHANGELOG, "2.4.0", "3.0.0");
    const versions = entries.map((e) => e.version);
    expect(versions).toContain("3.0.0");
    expect(versions).toContain("2.5.0");
    expect(versions).not.toContain("2.4.0"); // fromVersion is exclusive
  });

  it("extracts breaking changes from explicit Breaking Changes sections", () => {
    const { breakingChanges } = parseChangelog(SAMPLE_CHANGELOG, "2.4.0", "3.0.0");
    const descs = breakingChanges.map((b) => b.description);
    expect(descs).toContain("Renamed `createClient` to `buildClient`");
    expect(descs).toContain("Removed deprecated `legacyMode` option");
  });

  it("extracts conventional commit breaking indicators (feat!:)", () => {
    const { breakingChanges } = parseChangelog(SAMPLE_CHANGELOG, "2.4.0", "3.0.0");
    const conventionals = breakingChanges.filter((b) => b.conventionalCommit);
    expect(conventionals.length).toBeGreaterThan(0);
  });

  it("returns empty arrays when range has no entries", () => {
    const { entries, breakingChanges } = parseChangelog(SAMPLE_CHANGELOG, "3.0.0", "4.0.0");
    expect(entries).toHaveLength(0);
    expect(breakingChanges).toHaveLength(0);
  });

  it("marks sections as isBreaking when title matches breaking pattern", () => {
    const { entries } = parseChangelog(SAMPLE_CHANGELOG, "2.4.0", "3.0.0");
    const v3 = entries.find((e) => e.version === "3.0.0")!;
    const breakingSections = v3.sections.filter((s) => s.isBreaking);
    expect(breakingSections.length).toBeGreaterThan(0);
  });

  it("non-breaking sections are correctly flagged", () => {
    const { entries } = parseChangelog(SAMPLE_CHANGELOG, "2.4.0", "3.0.0");
    const v3 = entries.find((e) => e.version === "3.0.0")!;
    const features = v3.sections.find((s) => s.title === "Features");
    expect(features?.isBreaking).toBe(false);
  });

  it("captures rawMarkdown for each entry", () => {
    const { entries } = parseChangelog(SAMPLE_CHANGELOG, "2.4.0", "3.0.0");
    const v3 = entries.find((e) => e.version === "3.0.0")!;
    expect(v3.rawMarkdown).toContain("3.0.0");
  });

  it("handles changelog with no date in header", () => {
    const noDates = `## [1.0.0]\n\n### BREAKING CHANGES\n\n- Removed foo\n\n## [0.9.0]\n\n### Added\n\n- Initial release\n`;
    const { entries, breakingChanges } = parseChangelog(noDates, "0.9.0", "1.0.0");
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe("1.0.0");
    expect(breakingChanges).toHaveLength(1);
    expect(breakingChanges[0].description).toBe("Removed foo");
  });
});

describe("extractVersionBlock", () => {
  it("returns the block for a specific version", () => {
    const block = extractVersionBlock(SAMPLE_CHANGELOG, "2.5.0");
    expect(block).not.toBeNull();
    expect(block).toContain("2.5.0");
    expect(block).toContain("batch");
  });

  it("returns null when the version is not in the changelog", () => {
    const block = extractVersionBlock(SAMPLE_CHANGELOG, "99.0.0");
    expect(block).toBeNull();
  });

  it("does not include content from the next version section", () => {
    const block = extractVersionBlock(SAMPLE_CHANGELOG, "2.5.0");
    expect(block).not.toContain("2.4.0");
  });
});

describe("listVersions", () => {
  it("returns all versions in document order", () => {
    const versions = listVersions(SAMPLE_CHANGELOG);
    expect(versions).toEqual(["3.0.0", "2.5.0", "2.4.0"]);
  });

  it("returns empty array for changelog with no version headers", () => {
    const versions = listVersions("# Just a title\n\nSome text.");
    expect(versions).toEqual([]);
  });
});
