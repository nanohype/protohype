import { describe, it, expect } from "vitest";
import { buildPrDescription, validatePrDescription } from "./migration-notes.js";
import type { MigrationNotesInput } from "./types.js";

const baseInput: MigrationNotesInput = {
  packageName: "@aws-sdk/client-s3",
  fromVersion: "3.0.0",
  toVersion: "3.100.0",
  changelogUrl: "https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.100.0",
  breakingChanges: [],
  patchResults: [],
  teamId: "team-platform",
};

describe("buildPrDescription", () => {
  it("generates a branch name starting with feat/kiln-", () => {
    const { branchName } = buildPrDescription(baseInput);
    expect(branchName).toMatch(/^feat\/kiln-/);
  });

  it("includes the target version in the branch name", () => {
    const { branchName } = buildPrDescription(baseInput);
    expect(branchName).toContain("3.100.0");
  });

  it("generates a PR title mentioning the package and versions", () => {
    const { title } = buildPrDescription(baseInput);
    expect(title).toContain("@aws-sdk/client-s3");
    expect(title).toContain("3.100.0");
  });

  it("includes the changelog URL in the PR body", () => {
    const { body } = buildPrDescription(baseInput);
    expect(body).toContain("https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.100.0");
  });

  it("includes Migration Notes section", () => {
    const { body } = buildPrDescription(baseInput);
    expect(body).toContain("## Migration Notes");
  });

  it("states 'no breaking changes' when none are present", () => {
    const { body } = buildPrDescription(baseInput);
    expect(body.toLowerCase()).toContain("no breaking changes");
  });

  it("lists breaking changes when present", () => {
    const input: MigrationNotesInput = {
      ...baseInput,
      breakingChanges: [
        { description: "Renamed `createPresignedPost` to `createPresign`" },
        { description: "Removed `legacyEndpoints` option" },
      ],
    };
    const { body } = buildPrDescription(input);
    expect(body).toContain("Renamed `createPresignedPost`");
    expect(body).toContain("Removed `legacyEndpoints`");
    expect(body).toContain("Breaking Changes Identified");
  });

  it("lists patch results with file:line references", () => {
    const input: MigrationNotesInput = {
      ...baseInput,
      patchResults: [
        {
          spec: {
            filePath: "src/storage/client.ts",
            startLine: 42,
            endLine: 42,
            oldText: "createPresignedPost",
            newText: "createPresign",
            reason: "API renamed in v3.100",
          },
          status: "applied",
        },
      ],
    };
    const { body } = buildPrDescription(input);
    expect(body).toContain("src/storage/client.ts:42");
    expect(body).toContain("✅");
  });

  it("adds needs-human-review label when patches have conflicts", () => {
    const input: MigrationNotesInput = {
      ...baseInput,
      patchResults: [
        {
          spec: {
            filePath: "src/db.ts",
            startLine: 10,
            endLine: 10,
            oldText: "old",
            newText: "new",
            reason: "rename",
          },
          status: "conflict",
          message: "unexpected content",
        },
      ],
    };
    const { labels } = buildPrDescription(input);
    expect(labels).toContain("needs-human-review");
  });

  it("always includes kiln and dependencies labels", () => {
    const { labels } = buildPrDescription(baseInput);
    expect(labels).toContain("kiln");
    expect(labels).toContain("dependencies");
  });

  it("adds breaking-change label when breaking changes are present", () => {
    const input: MigrationNotesInput = {
      ...baseInput,
      breakingChanges: [{ description: "Renamed foo to bar" }],
    };
    const { labels } = buildPrDescription(input);
    expect(labels).toContain("breaking-change");
  });

  it("generates grouped PR title when groupedDeps are present", () => {
    const input: MigrationNotesInput = {
      ...baseInput,
      groupedDeps: [
        { packageName: "@aws-sdk/client-dynamodb", fromVersion: "3.0.0", toVersion: "3.100.0" },
        { packageName: "@aws-sdk/lib-dynamodb", fromVersion: "3.0.0", toVersion: "3.100.0" },
      ],
    };
    const { title } = buildPrDescription(input);
    expect(title).toContain("family");
    expect(title).toContain("3 packages");
  });
});

describe("validatePrDescription", () => {
  it("validates a well-formed PR description", () => {
    const desc = buildPrDescription(baseInput);
    const { valid, violations } = validatePrDescription(desc);
    expect(valid).toBe(true);
    expect(violations).toHaveLength(0);
  });

  it("reports violation when no changelog URL present", () => {
    const desc = buildPrDescription(baseInput);
    const { valid, violations } = validatePrDescription({
      ...desc,
      body: desc.body.replace(/https?:\/\/\S+/g, "[removed]"),
    });
    expect(valid).toBe(false);
    expect(violations.some((v) => v.includes("changelog URL"))).toBe(true);
  });

  it("reports violation when Migration Notes section is missing", () => {
    const desc = buildPrDescription(baseInput);
    const { valid, violations } = validatePrDescription({
      ...desc,
      body: desc.body.replace("## Migration Notes", "## Other Section"),
    });
    expect(valid).toBe(false);
    expect(violations.some((v) => v.includes("Migration Notes"))).toBe(true);
  });

  it("reports violation when branch name does not start with feat/kiln-", () => {
    const desc = buildPrDescription(baseInput);
    const { valid, violations } = validatePrDescription({
      ...desc,
      branchName: "main",
    });
    expect(valid).toBe(false);
    expect(violations.some((v) => v.includes("Branch name"))).toBe(true);
  });
});
