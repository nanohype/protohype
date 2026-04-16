import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
}));

import { fetchLatestVersion, fetchVersionsBetween, compareSemver } from "../../src/core/npm/registry.js";

describe("compareSemver", () => {
  it("returns 1 when a > b", () => {
    expect(compareSemver("2.0.0", "1.0.0")).toBe(1);
    expect(compareSemver("1.1.0", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
  });

  it("returns -1 when a < b", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
  });

  it("returns 0 when equal", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("handles v-prefixed versions", () => {
    expect(compareSemver("v2.0.0", "v1.0.0")).toBe(1);
    expect(compareSemver("v1.0.0", "v2.0.0")).toBe(-1);
  });
});

describe("fetchLatestVersion", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns version info for a known package", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          name: "react",
          version: "19.0.0",
          time: { "19.0.0": "2024-12-01T00:00:00.000Z" },
          repository: { url: "https://github.com/facebook/react" },
        }),
    } as unknown as Response);

    const info = await fetchLatestVersion("react");
    expect(info.name).toBe("react");
    expect(info.latestVersion).toBe("19.0.0");
    expect(info.repositoryUrl).toBe("https://github.com/facebook/react");
  });

  it("throws on non-OK response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as unknown as Response);

    await expect(fetchLatestVersion("nonexistent-pkg-xyz")).rejects.toThrow("npm registry returned 500");
  });

  it("throws on timeout", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    vi.mocked(fetch).mockRejectedValueOnce(abortError);

    await expect(fetchLatestVersion("slow-pkg")).rejects.toThrow("npm registry timeout");
  });
});

describe("fetchVersionsBetween", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns versions between from and to (exclusive/inclusive)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          versions: {
            "1.0.0": {},
            "1.1.0": {},
            "1.2.0": {},
            "2.0.0": {},
            "2.1.0": {},
          },
        }),
    } as unknown as Response);

    const versions = await fetchVersionsBetween("react", "1.1.0", "2.0.0");
    expect(versions).toContain("1.2.0");
    expect(versions).toContain("2.0.0");
    expect(versions).not.toContain("1.0.0");
    expect(versions).not.toContain("1.1.0"); // exclusive lower bound
    expect(versions).not.toContain("2.1.0"); // above upper bound
  });
});
