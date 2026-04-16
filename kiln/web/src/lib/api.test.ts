import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KilnApiError, getTeamConfig, listTeamPRs } from "./api";
import type { TeamConfig, KilnPR, PaginatedResponse } from "@/types";

const MOCK_CONFIG: TeamConfig = {
  teamId: "team-1",
  teamName: "Platform",
  watchedRepos: [],
  groupingStrategy: "per-dep",
  familyPatterns: [],
  targetVersionPolicy: "latest-stable",
  reviewSlaDays: 7,
  skipList: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const MOCK_PR: KilnPR = {
  id: "pr-1",
  prNumber: 42,
  prUrl: "https://github.com/acme/app/pull/42",
  repoFullName: "acme/app",
  headBranch: "feat/kiln-react-19",
  title: "chore(deps): upgrade react 18→19",
  status: "open",
  isSigned: true,
  teamId: "team-1",
  groupKey: "react",
  openedAt: "2024-03-01T10:00:00Z",
  migrationNotes: {
    summary: "Upgrade React from v18 to v19.",
    changelogUrls: ["https://react.dev/blog/2024/04/25/react-19"],
    breakingChanges: [],
    packages: [{ name: "react", fromVersion: "18.3.1", toVersion: "19.0.0" }],
  },
};

describe("KilnApiError", () => {
  it("is an instance of Error", () => {
    const err = new KilnApiError("NOT_FOUND", "Not found", "req-1", 404);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KilnApiError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.requestId).toBe("req-1");
  });
});

describe("getTeamConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns parsed team config on success", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_CONFIG,
    } as Response);

    const result = await getTeamConfig("team-1", "tok");
    expect(result.teamId).toBe("team-1");
    expect(result.groupingStrategy).toBe("per-dep");
  });

  it("throws KilnApiError on 404", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ code: "NOT_FOUND", message: "Team not found" }),
    } as Response);

    await expect(getTeamConfig("team-missing", "tok")).rejects.toBeInstanceOf(
      KilnApiError
    );
  });

  it("sends Authorization header", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_CONFIG,
    } as Response);

    await getTeamConfig("team-1", "my-token");

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer my-token"
    );
  });

  it("includes X-Request-Id header", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_CONFIG,
    } as Response);

    await getTeamConfig("team-1", "tok");

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(
      (init?.headers as Record<string, string>)["X-Request-Id"]
    ).toBeDefined();
  });

  it("throws KilnApiError with fallback values when response body is not JSON", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => { throw new Error("not json"); },
    } as unknown as Response);

    const err = await getTeamConfig("team-1", "tok").catch((e) => e);
    expect(err).toBeInstanceOf(KilnApiError);
    expect(err.code).toBe("UNKNOWN");
  });
});

describe("listTeamPRs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns paginated PR list", async () => {
    const response: PaginatedResponse<KilnPR> = {
      items: [MOCK_PR],
      totalCount: 1,
    };
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => response,
    } as Response);

    const result = await listTeamPRs("team-1", "tok");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("pr-1");
  });

  it("passes status filter as query param", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [], totalCount: 0 }),
    } as Response);

    await listTeamPRs("team-1", "tok", { status: "open" });

    const [url] = vi.mocked(global.fetch).mock.calls[0];
    expect(String(url)).toContain("status=open");
  });
});
