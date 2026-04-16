import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    changelog: {
      allowedDomains: ["github.com", "raw.githubusercontent.com", "npmjs.com", "registry.npmjs.org"],
      fetchTimeoutMs: 10000,
    },
  },
}));

import { fetchChangelog, BlockedDomainError, ChangelogFetchError } from "../../../src/core/changelog/fetcher.js";

describe("fetchChangelog", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches content from an allowed domain", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve("# Changelog\n## v2.0.0\n- Breaking: removed foo"),
    } as unknown as Response);

    const content = await fetchChangelog("https://github.com/owner/repo/blob/main/CHANGELOG.md");
    expect(content).toContain("Breaking: removed foo");
  });

  it("throws BlockedDomainError for disallowed domains", async () => {
    await expect(
      fetchChangelog("https://evil.com/changelog.md"),
    ).rejects.toThrow(BlockedDomainError);
  });

  it("throws BlockedDomainError for SSRF-like internal URLs", async () => {
    await expect(
      fetchChangelog("https://169.254.169.254/metadata"),
    ).rejects.toThrow(BlockedDomainError);
  });

  it("returns null for 404 responses", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as unknown as Response);

    const result = await fetchChangelog("https://github.com/owner/repo/releases/tag/v99.0.0");
    expect(result).toBeNull();
  });

  it("throws ChangelogFetchError for non-404 errors", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as unknown as Response);

    await expect(
      fetchChangelog("https://github.com/owner/repo/releases"),
    ).rejects.toThrow(ChangelogFetchError);
  });

  it("throws ChangelogFetchError on timeout", async () => {
    const mockFetch = vi.mocked(fetch);
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(
      fetchChangelog("https://github.com/owner/repo/releases"),
    ).rejects.toThrow(ChangelogFetchError);
  });

  it("rejects subdomain-bypass attempts on disallowed base domain", async () => {
    // evil.github.com.attacker.com should be blocked
    await expect(
      fetchChangelog("https://evil.github.com.attacker.com/changelog"),
    ).rejects.toThrow(BlockedDomainError);
  });

  it("allows raw.githubusercontent.com (CDN for GitHub raw files)", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve("## v1.0.0\n- Initial release"),
    } as unknown as Response);

    const result = await fetchChangelog("https://raw.githubusercontent.com/owner/repo/main/CHANGELOG.md");
    expect(result).toBeTruthy();
  });
});
