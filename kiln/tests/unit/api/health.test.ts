import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("../../src/telemetry/otel.js", () => ({
  log: vi.fn(),
  withSpan: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

import { Hono } from "hono";
import { registerHealthRoutes } from "../../src/api/routes/health.js";

describe("Health routes", () => {
  const app = new Hono();
  registerHealthRoutes(app);

  it("GET /healthz returns 200 with service name", async () => {
    const req = new Request("http://localhost/healthz");
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("kiln");
  });

  it("GET /readyz returns 200 with ready status", async () => {
    const req = new Request("http://localhost/readyz");
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ready");
  });
});
