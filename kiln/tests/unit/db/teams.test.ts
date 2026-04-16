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

import {
  getTeamConfig,
  putTeamConfig,
  TeamNotFoundError,
  TeamAccessDeniedError,
} from "../../../src/db/teams.js";
import type { TeamConfig } from "../../../src/types.js";

const mockTeamConfig: TeamConfig = {
  teamId: "team-123",
  orgId: "acme",
  repos: [
    {
      owner: "acme",
      repo: "backend",
      installationId: 12345,
      watchedDeps: ["react"],
      defaultBranch: "main",
    },
  ],
  targetVersionPolicy: "latest",
  reviewSlaDays: 7,
  slackChannel: "#eng-deps",
  linearProjectId: null,
  groupingStrategy: { kind: "per-dep" },
  pinnedSkipList: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("getTeamConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns team config when requester is in the team", async () => {
    mockSend.mockResolvedValueOnce({ Item: mockTeamConfig });

    const result = await getTeamConfig("team-123", ["team-123"], false);
    expect(result.teamId).toBe("team-123");
  });

  it("allows platform team to read any team config", async () => {
    mockSend.mockResolvedValueOnce({ Item: mockTeamConfig });

    const result = await getTeamConfig("team-123", [], true);
    expect(result.teamId).toBe("team-123");
  });

  it("throws TeamAccessDeniedError when requester is not in the team", async () => {
    await expect(
      getTeamConfig("team-123", ["team-456"], false),
    ).rejects.toThrow(TeamAccessDeniedError);

    // Should NOT call DynamoDB — ACL check must happen before DB read
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("throws TeamNotFoundError when team config does not exist", async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });

    await expect(
      getTeamConfig("team-999", ["team-999"], false),
    ).rejects.toThrow(TeamNotFoundError);
  });

  it("enforces isolation: team-A cannot read team-B config", async () => {
    // Red-team: team-456 trying to read team-123
    await expect(
      getTeamConfig("team-123", ["team-456"], false),
    ).rejects.toThrow(TeamAccessDeniedError);

    // DynamoDB must not have been called (ACL blocks before DB)
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("putTeamConfig", () => {
  it("writes the team config to DynamoDB", async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(putTeamConfig(mockTeamConfig)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledOnce();
  });
});
