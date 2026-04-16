import { describe, it, expect } from "vitest";
import {
  assertAllowedUrl,
  classifyBreakingChange,
  filterRelevantBreakingChanges,
} from "./classifier.js";
import type { ClassifiedBreakingChange } from "./classifier.js";

describe("assertAllowedUrl", () => {
  it("accepts github.com URLs", () => {
    const url = assertAllowedUrl("https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.0.0");
    expect(url.hostname).toBe("github.com");
  });

  it("accepts raw.githubusercontent.com URLs", () => {
    const url = assertAllowedUrl("https://raw.githubusercontent.com/owner/repo/main/CHANGELOG.md");
    expect(url.hostname).toBe("raw.githubusercontent.com");
  });

  it("accepts npmjs.com URLs", () => {
    const url = assertAllowedUrl("https://www.npmjs.com/package/react");
    expect(url.hostname).toBe("www.npmjs.com");
  });

  it("rejects URLs not on the allowlist", () => {
    expect(() =>
      assertAllowedUrl("https://evil.example.com/changelog")
    ).toThrow(/not on the allowlist/);
  });

  it("rejects invalid URLs", () => {
    expect(() => assertAllowedUrl("not-a-url")).toThrow(/Invalid changelog URL/);
  });

  it("rejects internal network addresses", () => {
    expect(() => assertAllowedUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
      /not on the allowlist/
    );
  });
});

describe("classifyBreakingChange", () => {
  it("classifies rename patterns as auto-patchable", () => {
    const result = classifyBreakingChange({
      description: "Renamed `createClient` to `buildClient` in the public API",
    });
    expect(result.severity).toBe("auto-patchable");
  });

  it("classifies 'replaced with' patterns as auto-patchable", () => {
    const result = classifyBreakingChange({
      description: "Replaced with `newMethod` for consistency",
    });
    expect(result.severity).toBe("auto-patchable");
  });

  it("classifies behavior-change patterns as needs-human", () => {
    const result = classifyBreakingChange({
      description: "Behavior has changed: now throws on empty input instead of returning null",
    });
    expect(result.severity).toBe("needs-human");
  });

  it("classifies 'may cause' patterns as needs-human", () => {
    const result = classifyBreakingChange({
      description: "This change may cause issues if you rely on the old error format",
    });
    expect(result.severity).toBe("needs-human");
  });

  it("classifies unrecognized patterns as informational", () => {
    const result = classifyBreakingChange({
      description: "The internal implementation has been refactored",
    });
    expect(result.severity).toBe("informational");
  });

  it("extracts backtick-quoted API identifiers", () => {
    const result = classifyBreakingChange({
      description: "Renamed `OldClass` to `NewClass`, affects `OldClass.method()`",
    });
    expect(result.affectedApis).toContain("OldClass");
    expect(result.affectedApis).toContain("NewClass");
    expect(result.affectedApis).toContain("OldClass.method()");
  });

  it("extracts single-quoted API identifiers", () => {
    const result = classifyBreakingChange({
      description: "The 'connectSync' method has been removed",
    });
    expect(result.affectedApis).toContain("connectSync");
  });
});

describe("filterRelevantBreakingChanges", () => {
  const changes: ClassifiedBreakingChange[] = [
    {
      description: "Renamed `createClient` to `buildClient`",
      severity: "auto-patchable",
      affectedApis: ["createClient", "buildClient"],
    },
    {
      description: "Removed `legacyConnect`",
      severity: "needs-human",
      affectedApis: ["legacyConnect"],
    },
    {
      description: "Configuration schema changed",
      severity: "needs-human",
      affectedApis: [],
    },
  ];

  it("returns all changes when usedApis is empty (conservative: show everything)", () => {
    const result = filterRelevantBreakingChanges(changes, new Set());
    expect(result).toHaveLength(3);
  });

  it("filters to changes affecting used APIs when usedApis is provided", () => {
    const result = filterRelevantBreakingChanges(changes, new Set(["createClient"]));
    // createClient change + changes with no affectedApis (schema change)
    const descs = result.map((c) => c.description);
    expect(descs).toContain("Renamed `createClient` to `buildClient`");
    expect(descs).toContain("Configuration schema changed"); // no affectedApis = always included
    expect(descs).not.toContain("Removed `legacyConnect`");
  });

  it("excludes changes whose APIs are not in the used set", () => {
    const result = filterRelevantBreakingChanges(changes, new Set(["someOtherApi"]));
    const descs = result.map((c) => c.description);
    expect(descs).not.toContain("Renamed `createClient` to `buildClient`");
    expect(descs).not.toContain("Removed `legacyConnect`");
    // schema change with no affectedApis is still included
    expect(descs).toContain("Configuration schema changed");
  });
});
