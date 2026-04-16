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

import { getCachedChangelog, putChangelogCache } from "../../../src/db/changelogs.js";

describe("getCachedChangelog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns cached entry when valid TTL", async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    mockSend.mockResolvedValueOnce({
      Item: {
        dep: "react",
        version: "19.0.0",
        fetchedAt: new Date().toISOString(),
        sourceUrl: "https://github.com/facebook/react/releases",
        rawContent: "## Breaking changes",
        breakingChanges: [],
        expiresAt: futureExpiry,
      },
    });

    const result = await getCachedChangelog("react", "19.0.0");
    expect(result?.dep).toBe("react");
    expect(result?.version).toBe("19.0.0");
  });

  it("returns null when item does not exist", async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await getCachedChangelog("react", "19.0.0");
    expect(result).toBeNull();
  });

  it("returns null when TTL has expired (stale cache)", async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 1; // expired 1 second ago
    mockSend.mockResolvedValueOnce({
      Item: {
        dep: "react",
        version: "18.0.0",
        fetchedAt: new Date().toISOString(),
        sourceUrl: "https://github.com/facebook/react/releases",
        rawContent: "old content",
        breakingChanges: [],
        expiresAt: pastExpiry,
      },
    });

    const result = await getCachedChangelog("react", "18.0.0");
    expect(result).toBeNull(); // TTL expired — should not serve stale cache
  });
});

describe("putChangelogCache", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores the entry with a future expiresAt TTL", async () => {
    mockSend.mockResolvedValueOnce({});
    await putChangelogCache({
      dep: "react",
      version: "19.0.0",
      fetchedAt: new Date().toISOString(),
      sourceUrl: "https://github.com/facebook/react/releases",
      rawContent: "## Breaking changes",
      breakingChanges: [],
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const sentItem = mockSend.mock.calls[0]?.[0]?.input?.Item ?? mockSend.mock.calls[0]?.[0]?.input;
    // expiresAt should be in the future
    expect(sentItem?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
