import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist all mocks
vi.mock("../../../src/core/changelog/fetcher.js", () => ({
  fetchChangelog: vi.fn(),
  resolveChangelogUrls: vi.fn(),
}));

vi.mock("../../../src/core/changelog/parser.js", () => ({
  extractVersionSection: vi.fn((raw: string) => raw),
  hasPotentialBreakingChanges: vi.fn(() => true),
}));

vi.mock("../../../src/core/bedrock/client.js", () => ({
  classifyChangelog: vi.fn(),
  synthesizeMigration: vi.fn(),
}));

vi.mock("../../../src/core/codebase/scanner.js", () => ({
  scanUsageSites: vi.fn(),
}));

vi.mock("../../../src/core/github/app.js", () => ({
  getInstallationToken: vi.fn(),
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../../../src/core/github/pr.js", () => ({
  createUpgradePR: vi.fn(),
}));

vi.mock("../../../src/db/changelogs.js", () => ({
  getCachedChangelog: vi.fn(),
  putChangelogCache: vi.fn(),
}));

vi.mock("../../../src/db/upgrades.js", () => ({
  putUpgradeRecord: vi.fn(),
  updateUpgradeStatus: vi.fn(),
}));

vi.mock("../../../src/telemetry/otel.js", () => ({
  log: vi.fn(),
  withSpan: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../../../src/config.js", () => ({
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

import { runUpgradePipeline } from "../../../src/workers/upgrader.js";
import { fetchChangelog, resolveChangelogUrls } from "../../../src/core/changelog/fetcher.js";
import { classifyChangelog, synthesizeMigration } from "../../../src/core/bedrock/client.js";
import { scanUsageSites } from "../../../src/core/codebase/scanner.js";
import { getInstallationToken } from "../../../src/core/github/app.js";
import { createUpgradePR } from "../../../src/core/github/pr.js";
import { getCachedChangelog, putChangelogCache } from "../../../src/db/changelogs.js";
import { putUpgradeRecord, updateUpgradeStatus } from "../../../src/db/upgrades.js";
import type { UpgradeJob } from "../../../src/workers/upgrader.js";

const job: UpgradeJob = {
  teamId: "team-123",
  repoConfig: {
    owner: "acme",
    repo: "backend",
    installationId: 12345,
    watchedDeps: ["react"],
    defaultBranch: "main",
  },
  dep: "react",
  fromVersion: "18.0.0",
  toVersion: "19.0.0",
  groupId: null,
};

describe("runUpgradePipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses cached changelog when available — skips fetcher and Bedrock", async () => {
    vi.mocked(getCachedChangelog).mockResolvedValueOnce({
      dep: "react",
      version: "19.0.0",
      fetchedAt: new Date().toISOString(),
      sourceUrl: "https://github.com/facebook/react/releases/tag/v19.0.0",
      rawContent: "## Breaking changes",
      breakingChanges: [
        { description: "Removed legacyContext", category: "api-removal", affectedSymbol: "contextTypes" },
      ],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.mocked(getInstallationToken).mockResolvedValueOnce({
      token: "ghs_test",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      installationId: 12345,
    });
    vi.mocked(scanUsageSites).mockResolvedValueOnce([]);
    vi.mocked(createUpgradePR).mockResolvedValueOnce({
      number: 42,
      url: "https://github.com/acme/backend/pull/42",
      branchName: "feat/kiln-react-19.0.0",
    });
    vi.mocked(putUpgradeRecord).mockResolvedValueOnce(undefined);
    vi.mocked(updateUpgradeStatus).mockResolvedValue(undefined);

    const record = await runUpgradePipeline(job);

    expect(vi.mocked(fetchChangelog)).not.toHaveBeenCalled();
    expect(vi.mocked(classifyChangelog)).not.toHaveBeenCalled();
    expect(record.status).toBe("pr-opened");
    expect(record.prNumber).toBe(42);
  });

  it("fetches and classifies changelog when not cached", async () => {
    vi.mocked(getCachedChangelog).mockResolvedValueOnce(null);
    vi.mocked(resolveChangelogUrls).mockResolvedValueOnce([
      "https://github.com/facebook/react/releases/tag/v19.0.0",
    ]);
    vi.mocked(fetchChangelog).mockResolvedValueOnce("## Breaking Changes\n- Removed legacyContext");
    vi.mocked(classifyChangelog).mockResolvedValueOnce({
      hasBreakingChanges: true,
      breakingChanges: [
        { description: "Removed legacyContext API", category: "api-removal", affectedSymbol: "contextTypes" },
      ],
      changelogUrls: ["https://github.com/facebook/react/releases/tag/v19.0.0"],
    });
    vi.mocked(putChangelogCache).mockResolvedValueOnce(undefined);
    vi.mocked(getInstallationToken).mockResolvedValueOnce({
      token: "ghs_test",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      installationId: 12345,
    });
    vi.mocked(scanUsageSites).mockResolvedValueOnce([
      { filePath: "src/App.tsx", lineNumber: 42, lineContent: "contextTypes = {...}", symbol: "contextTypes" },
    ]);
    vi.mocked(synthesizeMigration).mockResolvedValueOnce({
      patches: [
        {
          filePath: "src/App.tsx",
          lineStart: 42,
          lineEnd: 42,
          originalCode: "contextTypes = {...}",
          patchedCode: "// contextTypes removed — use modern context API",
          breakingChangeDescription: "Removed legacyContext API",
          confidence: "high",
        },
      ],
      humanReviewItems: [],
    });
    vi.mocked(createUpgradePR).mockResolvedValueOnce({
      number: 43,
      url: "https://github.com/acme/backend/pull/43",
      branchName: "feat/kiln-react-19.0.0",
    });
    vi.mocked(putUpgradeRecord).mockResolvedValueOnce(undefined);
    vi.mocked(updateUpgradeStatus).mockResolvedValue(undefined);

    const record = await runUpgradePipeline(job);

    expect(vi.mocked(fetchChangelog)).toHaveBeenCalledOnce();
    expect(vi.mocked(classifyChangelog)).toHaveBeenCalledOnce();
    expect(record.patchedFiles).toHaveLength(1);
    expect(record.status).toBe("pr-opened");
  });

  it("marks status as failed and records error when pipeline throws", async () => {
    vi.mocked(getCachedChangelog).mockRejectedValueOnce(new Error("DynamoDB timeout"));
    vi.mocked(putUpgradeRecord).mockResolvedValueOnce(undefined);
    vi.mocked(updateUpgradeStatus).mockResolvedValue(undefined);

    const record = await runUpgradePipeline(job);

    expect(record.status).toBe("failed");
    expect(record.errorMessage).toContain("DynamoDB timeout");
    // Audit write must have been called
    expect(vi.mocked(updateUpgradeStatus)).toHaveBeenCalledWith(
      "team-123",
      expect.any(String),
      "failed",
      expect.objectContaining({ errorMessage: expect.stringContaining("DynamoDB timeout") }),
    );
  });

  it("records audit write on initial creation (no fire-and-forget)", async () => {
    vi.mocked(getCachedChangelog).mockRejectedValueOnce(new Error("fail fast"));
    vi.mocked(putUpgradeRecord).mockResolvedValueOnce(undefined);
    vi.mocked(updateUpgradeStatus).mockResolvedValue(undefined);

    await runUpgradePipeline(job);

    // putUpgradeRecord must be called at start (audit trail from creation)
    expect(vi.mocked(putUpgradeRecord)).toHaveBeenCalledOnce();
  });
});
