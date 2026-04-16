import { describe, it, expect } from "vitest";
import { extractVersionSection, hasPotentialBreakingChanges } from "../../../src/core/changelog/parser.js";

describe("extractVersionSection", () => {
  it("extracts the correct version section from a Keep a Changelog format", () => {
    const changelog = `
# Changelog

## [2.0.0] - 2024-01-15

### Breaking Changes
- Removed \`legacyMethod\`
- Renamed \`oldApi\` to \`newApi\`

### Added
- New feature X

## [1.9.0] - 2023-12-01

### Added
- Feature Y

## [1.8.0] - 2023-11-01

### Fixed
- Bug Z
`;

    const section = extractVersionSection(changelog, "1.9.0", "2.0.0");
    expect(section).toContain("Removed `legacyMethod`");
    expect(section).toContain("Renamed `oldApi` to `newApi`");
    expect(section).not.toContain("Feature Y");
    expect(section).not.toContain("Bug Z");
  });

  it("returns partial content when version section not found", () => {
    const changelog = "Some changelog without version headers";
    const section = extractVersionSection(changelog, "1.0.0", "2.0.0");
    expect(section).toBe(changelog); // falls back to raw content
  });

  it("handles v-prefixed version headers", () => {
    const changelog = `
## v2.0.0
Breaking: removed foo()

## v1.0.0
Initial release
`;
    const section = extractVersionSection(changelog, "1.0.0", "2.0.0");
    expect(section).toContain("Breaking: removed foo()");
    expect(section).not.toContain("Initial release");
  });

  it("caps output at 16000 chars", () => {
    const longChangelog = "## [99.0.0]\n" + "x".repeat(20_000);
    const section = extractVersionSection(longChangelog, "1.0.0", "99.0.0");
    expect(section.length).toBeLessThanOrEqual(16_000);
  });
});

describe("hasPotentialBreakingChanges", () => {
  it("detects 'breaking change' keyword", () => {
    expect(hasPotentialBreakingChanges("This is a breaking change")).toBe(true);
  });

  it("detects 'BREAKING' uppercase", () => {
    expect(hasPotentialBreakingChanges("BREAKING: removed API")).toBe(true);
  });

  it("detects removed API patterns", () => {
    expect(hasPotentialBreakingChanges("removed method doSomething()")).toBe(true);
    expect(hasPotentialBreakingChanges("Removed export MyClass")).toBe(true);
  });

  it("detects migration guide mentions", () => {
    expect(hasPotentialBreakingChanges("See migration guide for details")).toBe(true);
    expect(hasPotentialBreakingChanges("Migration required from v1 to v2")).toBe(true);
  });

  it("detects incompatible keyword", () => {
    expect(hasPotentialBreakingChanges("This change is incompatible with prior versions")).toBe(true);
  });

  it("returns false for patch-only changelogs", () => {
    expect(hasPotentialBreakingChanges("Fixed a bug in error handling\nUpdated dependencies")).toBe(false);
  });

  it("returns false for deprecation-only notices", () => {
    // Deprecations that still work are NOT breaking
    expect(hasPotentialBreakingChanges("Added new method, old method will be removed in v3")).toBe(false);
  });
});
