/**
 * Integration test — upgrade pipeline orchestration.
 * Tests the full flow from changelog fetch through PR creation with mocked external dependencies.
 * This is the integration test required for the orchestrator (runUpgradePipeline)
 * that makes 2+ external calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external clients
vi.mock("../../src/core/changelog/fetcher.js", () => ({
  fetchChangelog: vi.fn(),
  resolveChangelogUrls: vi.fn(),
}));
vi.mock("../../src/core/changelog/parser.js", () => ({
  extractVersionSection: vi.fn((raw: string) => raw),
  hasPotentialBreakingChanges: vi.fn(() => true),
}));
vi.mock("../../src/core/bedrock/client.js", () => ({
  classifyChangelog: vi.fn(),
  synthesizeMigration: vi.fn(),
}));
vi.mock("../../src/core/codebase/scanner.js", () => ({
  scanUsageSites: vi.fn(),
}));
vi.mock("../../src/core/github/app.js", () => ({
  getInstallationToken: vi.fn(),
  fetchWithTimeout: vi.fn(),
}));
vi.mock("../../src/core/github/pr.js", () => ({
  createUpgradePR: vi.fn(),
}));
vi.mock("../../src/db/changelogs.js", () => ({
  getCachedChangelog: vi.fn(),
  putChangelogCache: vi.fn(),
}));
vi.mock("../../src/db/upgrades.js", () => ({
  putUpgradeRecord: vi.fn(),
  updateUpgradeStatus: vi.fn(),
}));
vi.mock("../../src/telemetry/otel.js", () => ({
  log: vi.fn(),
  withSpan: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("../../src/config.js", () => ({
  config: {
    aws: { region: "us-west-2" },
    dynamodb: {
      teamsTable: "kiln-teams",
      upgradesTable: "kiln-upgrades",
      changelogsTable: "kiln-changelogs",
      rateLimitTable: "kiln-rate-limit",
    },
    github: { rateLimitPerHour: 4500, appSecretArn: "arn:test", readTimeoutMs: 5000, writeTimeoutMs: 15000 },
    bedrock: { region: "us-west-2", changelogModel: "m", migrationModel: "m", complexModel: "m", timeoutMs: 30000, promptCachingEnabled: true },
    npm: { registryUrl: "https://registry.npmjs.org", pollIntervalMs: 300000, timeoutMs: 10000 },
    okta: { domain: "test.okta.com", audience: "api://kiln" },
    server: { port: 3000, logLevel: "info" },
    changelog: { allowedDomains: ["github.com"], fetchTimeoutMs: 10000 },
  },
}));

import { runUpgradePipeline, type UpgradeJob } from "../../src/workers/upgrader.js";
import { resolveChangelogUrls, fetchChangelog } from "../../src/core/changelog/fetcher.js";
import { classifyChangelog, synthesizeMigration } from "../../src/core/bedrock/client.js";
import { scanUsageSites } from "../../src/core/codebase/scanner.js";
import { getInstallationToken } from "../../src/core/github/app.js";
import { createUpgradePR } from "../../src/core/github/pr.js";
import { getCachedChangelog, putChangelogCache } from "../../src/db/changelogs.js";
import { putUpgradeRecord, updateUpgradeStatus } from "../../src/db/upgrades.js";

describe("Upgrade pipeline — full end-to-end flow", () => {
  const job: UpgradeJob = {
    teamId: "team-alpha",
    repoConfig: {
      owner: "acme-corp",
      repo: "platform-api",
      installationId: 99999,
      watchedDeps: ["@aws-sdk/client-s3"],
      defaultBranch: "main",
    },
    dep: "@aws-sdk/client-s3",
    fromVersion: "3.100.0",
    toVersion: "3.200.0",
    groupId: "family:@aws-sdk/*@3.200.0",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(putUpgradeRecord).mockResolvedValue(undefined);
    vi.mocked(updateUpgradeStatus).mockResolvedValue(undefined);
    vi.mocked(putChangelogCache).mockResolvedValue(undefined);
    vi.mocked(getInstallationToken).mockResolvedValue({
      token: "ghs_integration_test",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      installationId: 99999,
    });
  });

  it("completes full happy path: fetch → classify → scan → patch → PR", async () => {
    vi.mocked(getCachedChangelog).mockResolvedValueOnce(null);
    vi.mocked(resolveChangelogUrls).mockResolvedValueOnce([
      "https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.200.0",
    ]);
    vi.mocked(fetchChangelog).mockResolvedValueOnce(
      "## Breaking Changes\n- Removed `getObject` callback form — use async/await",
    );
    vi.mocked(classifyChangelog).mockResolvedValueOnce({
      hasBreakingChanges: true,
      breakingChanges: [
        {
          description: "Removed callback form of getObject — use async/await",
          category: "api-removal",
          affectedSymbol: "getObject",
        },
      ],
      changelogUrls: ["https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.200.0"],
    });
    vi.mocked(scanUsageSites).mockResolvedValueOnce([
      {
        filePath: "src/storage/s3.ts",
        lineNumber: 87,
        lineContent: "s3.getObject(params, (err, data) => {",
        symbol: "getObject",
      },
    ]);
    vi.mocked(synthesizeMigration).mockResolvedValueOnce({
      patches: [
        {
          filePath: "src/storage/s3.ts",
          lineStart: 87,
          lineEnd: 90,
          originalCode: "s3.getObject(params, (err, data) => {",
          patchedCode: "const data = await s3.getObject(params);",
          breakingChangeDescription: "Removed callback form of getObject",
          confidence: "high",
        },
      ],
      humanReviewItems: [],
    });
    vi.mocked(createUpgradePR).mockResolvedValueOnce({
      number: 101,
      url: "https://github.com/acme-corp/platform-api/pull/101",
      branchName: "feat/kiln--aws-sdk-client-s3-3.200.0",
    });

    const record = await runUpgradePipeline(job);

    // PR opened
    expect(record.status).toBe("pr-opened");
    expect(record.prNumber).toBe(101);
    expect(record.prUrl).toBe("https://github.com/acme-corp/platform-api/pull/101");

    // Breaking changes identified
    expect(record.breakingChanges).toHaveLength(1);
    expect(record.breakingChanges[0]?.affectedSymbol).toBe("getObject");

    // Patches applied
    expect(record.patchedFiles).toHaveLength(1);
    expect(record.patchedFiles[0]?.filePath).toBe("src/storage/s3.ts");

    // No human review items
    expect(record.humanReviewItems).toHaveLength(0);

    // Changelog URLs cited
    expect(record.changelogUrls.length).toBeGreaterThan(0);

    // Audit writes happened (no fire-and-forget)
    expect(vi.mocked(putUpgradeRecord)).toHaveBeenCalledOnce();
    expect(vi.mocked(updateUpgradeStatus)).toHaveBeenCalledWith(
      "team-alpha",
      expect.any(String),
      "pr-opened",
      expect.objectContaining({ prNumber: 101 }),
    );
  });

  it("routes low-confidence patches to humanReviewItems", async () => {
    vi.mocked(getCachedChangelog).mockResolvedValueOnce(null);
    vi.mocked(resolveChangelogUrls).mockResolvedValueOnce(["https://github.com/aws/aws-sdk-js-v3/releases"]);
    vi.mocked(fetchChangelog).mockResolvedValueOnce("## Breaking\n- Complex behavior change");
    vi.mocked(classifyChangelog).mockResolvedValueOnce({
      hasBreakingChanges: true,
      breakingChanges: [{ description: "Complex behavior change", category: "behavior-change", affectedSymbol: null }],
      changelogUrls: [],
    });
    vi.mocked(scanUsageSites).mockResolvedValueOnce([
      { filePath: "src/complex.ts", lineNumber: 10, lineContent: "doComplexThing()", symbol: "doComplexThing" },
    ]);
    vi.mocked(synthesizeMigration).mockResolvedValueOnce({
      patches: [
        {
          filePath: "src/complex.ts",
          lineStart: 10,
          lineEnd: 10,
          originalCode: "doComplexThing()",
          patchedCode: "doComplexThingNew()",
          breakingChangeDescription: "Complex behavior change",
          confidence: "low", // ← low confidence
        },
      ],
      humanReviewItems: [],
    });
    vi.mocked(createUpgradePR).mockResolvedValueOnce({
      number: 102,
      url: "https://github.com/acme-corp/platform-api/pull/102",
      branchName: "feat/kiln--aws-sdk-client-s3-3.200.0",
    });

    const record = await runUpgradePipeline(job);

    // Low-confidence patch → human review, not automatic patch
    expect(record.patchedFiles).toHaveLength(0);
    expect(record.humanReviewItems).toHaveLength(1);
    expect(record.humanReviewItems[0]?.reason).toContain("Low-confidence patch");
  });

  it("handles complete failure gracefully and records error audit trail", async () => {
    vi.mocked(getCachedChangelog).mockRejectedValueOnce(new Error("DynamoDB timeout — connection refused"));

    const record = await runUpgradePipeline(job);

    expect(record.status).toBe("failed");
    expect(record.errorMessage).toContain("DynamoDB timeout");

    // Audit trail preserved
    expect(vi.mocked(putUpgradeRecord)).toHaveBeenCalledOnce();
    expect(vi.mocked(updateUpgradeStatus)).toHaveBeenCalledWith(
      "team-alpha",
      expect.any(String),
      "failed",
      { errorMessage: expect.stringContaining("DynamoDB timeout") },
    );
  });

  it("skips Bedrock classification when heuristic finds no potential breaking changes", async () => {
    const { hasPotentialBreakingChanges } = await import("../../src/core/changelog/parser.js");
    vi.mocked(hasPotentialBreakingChanges).mockReturnValueOnce(false);

    vi.mocked(getCachedChangelog).mockResolvedValueOnce(null);
    vi.mocked(resolveChangelogUrls).mockResolvedValueOnce(["https://github.com/aws/aws-sdk-js-v3/releases"]);
    vi.mocked(fetchChangelog).mockResolvedValueOnce("## v3.200.0\n- Fixed a bug in retry logic");
    vi.mocked(createUpgradePR).mockResolvedValueOnce({
      number: 103,
      url: "https://github.com/acme-corp/platform-api/pull/103",
      branchName: "feat/kiln--aws-sdk-client-s3-3.200.0",
    });

    const record = await runUpgradePipeline(job);

    // Bedrock not called — heuristic screened it out
    expect(vi.mocked(classifyChangelog)).not.toHaveBeenCalled();
    expect(record.breakingChanges).toHaveLength(0);
    expect(record.status).toBe("pr-opened");
  });
});
