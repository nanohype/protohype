import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DynamoDB before imports
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
    github: {
      rateLimitPerHour: 100,
      appSecretArn: "arn:test",
      readTimeoutMs: 5000,
      writeTimeoutMs: 15000,
    },
    bedrock: {
      region: "us-west-2",
      changelogModel: "test-model",
      migrationModel: "test-model",
      complexModel: "test-model",
      timeoutMs: 30000,
      promptCachingEnabled: true,
    },
    npm: { registryUrl: "https://registry.npmjs.org", pollIntervalMs: 300000, timeoutMs: 10000 },
    okta: { domain: "test.okta.com", audience: "api://kiln" },
    server: { port: 3000, logLevel: "info" },
    changelog: { allowedDomains: ["github.com"], fetchTimeoutMs: 10000 },
  },
}));

import { consumeGitHubTokens, RateLimitExceededError } from "../../../src/core/github/rate-limiter.js";

describe("consumeGitHubTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes bucket on first call and deducts tokens", async () => {
    // First GetCommand — no item exists
    mockSend
      .mockResolvedValueOnce({ Item: undefined }) // GetCommand
      .mockResolvedValueOnce({}); // UpdateCommand

    await expect(consumeGitHubTokens(1)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("deducts from existing bucket", async () => {
    const now = Date.now();
    mockSend
      .mockResolvedValueOnce({
        Item: { tokens: 50, lastRefillAt: now - 1000 },
      })
      .mockResolvedValueOnce({});

    await expect(consumeGitHubTokens(5)).resolves.toBeUndefined();
  });

  it("throws RateLimitExceededError when insufficient tokens", async () => {
    const now = Date.now();
    mockSend.mockResolvedValueOnce({
      Item: { tokens: 2, lastRefillAt: now - 1000 },
    });

    await expect(consumeGitHubTokens(10)).rejects.toThrow(RateLimitExceededError);
  });

  it("refills bucket after 1 hour", async () => {
    const hourAgo = Date.now() - 61 * 60 * 1000;
    mockSend
      .mockResolvedValueOnce({
        Item: { tokens: 0, lastRefillAt: hourAgo },
      })
      .mockResolvedValueOnce({});

    // Should refill to 100 and not throw
    await expect(consumeGitHubTokens(1)).resolves.toBeUndefined();
  });

  it("retries on ConditionalCheckFailedException", async () => {
    const { ConditionalCheckFailedException } = await import("@aws-sdk/client-dynamodb");
    const now = Date.now();

    mockSend
      // First attempt: get succeeds
      .mockResolvedValueOnce({ Item: { tokens: 50, lastRefillAt: now - 1000 } })
      // First update: conflict
      .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "conflict", $metadata: {} }))
      // Second attempt: get succeeds
      .mockResolvedValueOnce({ Item: { tokens: 49, lastRefillAt: now - 1000 } })
      // Second update: success
      .mockResolvedValueOnce({});

    await expect(consumeGitHubTokens(1)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(4);
  });
});
