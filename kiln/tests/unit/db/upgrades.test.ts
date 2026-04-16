import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSend = vi.fn();
vi.mock("../../../src/db/client.js", () => ({
  getDocumentClient: () => ({ send: mockSend }),
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

import { putUpgradeRecord, getUpgradeRecord, updateUpgradeStatus, listUpgradesByTeam } from "../../../src/db/upgrades.js";
import type { UpgradeRecord } from "../../../src/types.js";

const sampleRecord: UpgradeRecord = {
  upgradeId: "upgrade-abc",
  teamId: "team-123",
  owner: "acme",
  repo: "backend",
  dep: "react",
  fromVersion: "18.0.0",
  toVersion: "19.0.0",
  groupId: null,
  status: "pending",
  prNumber: null,
  prUrl: null,
  changelogUrls: [],
  breakingChanges: [],
  patchedFiles: [],
  humanReviewItems: [],
  errorMessage: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("putUpgradeRecord", () => {
  beforeEach(() => vi.clearAllMocks());

  it("awaits the DynamoDB write (no fire-and-forget)", async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(putUpgradeRecord(sampleRecord)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledOnce();
  });
});

describe("getUpgradeRecord", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the record when found", async () => {
    mockSend.mockResolvedValueOnce({ Item: sampleRecord });
    const result = await getUpgradeRecord("team-123", "upgrade-abc");
    expect(result?.upgradeId).toBe("upgrade-abc");
  });

  it("returns null when not found", async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await getUpgradeRecord("team-123", "upgrade-xyz");
    expect(result).toBeNull();
  });
});

describe("updateUpgradeStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("awaits the status update (no fire-and-forget)", async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(
      updateUpgradeStatus("team-123", "upgrade-abc", "pr-opened", { prNumber: 42, prUrl: "https://github.com/x/y/pull/42" }),
    ).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("builds correct SET expression for extra fields", async () => {
    mockSend.mockResolvedValueOnce({});
    await updateUpgradeStatus("team-123", "upgrade-abc", "failed", { errorMessage: "timeout" });
    const call = mockSend.mock.calls[0]?.[0]?.input ?? mockSend.mock.calls[0]?.[0];
    expect(call.UpdateExpression).toContain("errorMessage");
  });
});

describe("listUpgradesByTeam", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns items from DynamoDB query", async () => {
    mockSend.mockResolvedValueOnce({ Items: [sampleRecord] });
    const items = await listUpgradesByTeam("team-123");
    expect(items).toHaveLength(1);
    expect(items[0]?.upgradeId).toBe("upgrade-abc");
  });

  it("returns empty array when no items", async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    const items = await listUpgradesByTeam("team-123");
    expect(items).toHaveLength(0);
  });
});
