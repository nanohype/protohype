import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth middleware — Okta JWT verification is an external IdP boundary
vi.mock("../../../src/api/middleware/auth.js", () => ({
  authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
  getIdentity: vi.fn(() => ({
    sub: "okta-user-001",
    email: "alice@acme.com",
    groups: ["kiln-team-team-123"],
    teamIds: ["team-123"],
  })),
  isPlatformTeam: vi.fn(() => false),
}));

// Mock DynamoDB
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

vi.mock("../../../src/telemetry/otel.js", () => ({
  log: vi.fn(),
}));

import { Hono } from "hono";
import { registerTeamRoutes } from "../../../src/api/routes/teams.js";
import type { TeamConfig } from "../../../src/types.js";

const mockTeam: TeamConfig = {
  teamId: "team-123",
  orgId: "acme",
  repos: [{ owner: "acme", repo: "backend", installationId: 12345, watchedDeps: ["react"], defaultBranch: "main" }],
  targetVersionPolicy: "latest",
  reviewSlaDays: 7,
  slackChannel: "#deps",
  linearProjectId: null,
  groupingStrategy: { kind: "per-dep" },
  pinnedSkipList: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function makeApp() {
  const app = new Hono();
  registerTeamRoutes(app);
  return app;
}

describe("GET /teams/:teamId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with team config for authorized requester", async () => {
    mockSend.mockResolvedValueOnce({ Item: mockTeam });
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/teams/team-123", {
        headers: { Authorization: "Bearer test-token" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as TeamConfig;
    expect(body.teamId).toBe("team-123");
  });

  it("returns 403 when requester is not in the team", async () => {
    const { getIdentity } = await import("../../../src/api/middleware/auth.js");
    vi.mocked(getIdentity).mockReturnValueOnce({
      sub: "okta-user-002",
      email: "bob@acme.com",
      groups: ["kiln-team-team-456"],
      teamIds: ["team-456"], // different team
    });
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/teams/team-123", {
        headers: { Authorization: "Bearer test-token" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when team does not exist", async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/teams/team-999", {
        headers: { Authorization: "Bearer test-token" },
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /teams", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 for non-platform-team members", async () => {
    const { isPlatformTeam } = await import("../../../src/api/middleware/auth.js");
    vi.mocked(isPlatformTeam).mockReturnValueOnce(false);
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/teams", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "acme", repos: [] }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on invalid body", async () => {
    const { isPlatformTeam } = await import("../../../src/api/middleware/auth.js");
    vi.mocked(isPlatformTeam).mockReturnValueOnce(true);
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/teams", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "" }), // missing repos
      }),
    );
    expect(res.status).toBe(400);
  });

  it("creates team config for platform team", async () => {
    const { isPlatformTeam } = await import("../../../src/api/middleware/auth.js");
    vi.mocked(isPlatformTeam).mockReturnValueOnce(true);
    mockSend.mockResolvedValueOnce({}); // putTeamConfig
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/teams", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId: "acme",
          repos: [{ owner: "acme", repo: "backend", installationId: 12345, watchedDeps: ["react"] }],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { teamId: string };
    expect(body.teamId).toBeTruthy();
  });
});
