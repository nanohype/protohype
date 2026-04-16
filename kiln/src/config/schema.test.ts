import { describe, it, expect } from "vitest";
import { parseTeamConfig, isSkipped, TeamConfigSchema } from "./schema.js";

const validConfig = {
  teamId: "team-platform",
  orgId: "nanocorp",
  watchedRepos: ["nanocorp/api", "nanocorp/frontend"],
  targetVersionPolicy: "latest",
  reviewSlaTtlHours: 168,
  slackChannel: "#deps-alerts",
  pinnedSkipList: [],
  groupingStrategy: { type: "per-dep" },
  linearProjectId: "LIN-123",
  enabled: true,
};

describe("parseTeamConfig", () => {
  it("accepts a valid full config", () => {
    const result = parseTeamConfig(validConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.teamId).toBe("team-platform");
      expect(result.config.watchedRepos).toHaveLength(2);
    }
  });

  it("applies defaults for optional fields", () => {
    const minimal = {
      teamId: "team-a",
      orgId: "org-a",
      watchedRepos: ["org-a/repo"],
    };
    const result = parseTeamConfig(minimal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.targetVersionPolicy).toBe("latest");
      expect(result.config.reviewSlaTtlHours).toBe(168);
      expect(result.config.pinnedSkipList).toEqual([]);
      expect(result.config.enabled).toBe(true);
    }
  });

  it("rejects missing required fields", () => {
    const result = parseTeamConfig({ teamId: "team-a" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("orgId"))).toBe(true);
    }
  });

  it("rejects empty watchedRepos array", () => {
    const result = parseTeamConfig({ ...validConfig, watchedRepos: [] });
    expect(result.ok).toBe(false);
  });

  it("accepts per-family grouping strategy", () => {
    const result = parseTeamConfig({
      ...validConfig,
      groupingStrategy: { type: "per-family", pattern: "@aws-sdk/*" },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts per-release-window grouping strategy", () => {
    const result = parseTeamConfig({
      ...validConfig,
      groupingStrategy: { type: "per-release-window", windowDays: 14 },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid windowDays (0)", () => {
    const result = parseTeamConfig({
      ...validConfig,
      groupingStrategy: { type: "per-release-window", windowDays: 0 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid repo format (missing owner)", () => {
    const result = parseTeamConfig({
      ...validConfig,
      watchedRepos: ["just-a-repo-name"],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid slack channel (missing #)", () => {
    const result = parseTeamConfig({
      ...validConfig,
      slackChannel: "no-hash",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts pinned version policy", () => {
    const result = parseTeamConfig({
      ...validConfig,
      targetVersionPolicy: { pinned: "3.5.2" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.targetVersionPolicy).toEqual({ pinned: "3.5.2" });
    }
  });
});

describe("isSkipped", () => {
  it("returns true for exact name match", () => {
    expect(isSkipped("react", ["react", "next"])).toBe(true);
  });

  it("returns false when not in list", () => {
    expect(isSkipped("typescript", ["react", "next"])).toBe(false);
  });

  it("matches name@version entries by name", () => {
    expect(isSkipped("react", ["react@18.2.0"])).toBe(true);
  });

  it("does not match partial names", () => {
    expect(isSkipped("react", ["react-dom"])).toBe(false);
  });

  it("returns false for empty skip list", () => {
    expect(isSkipped("anything", [])).toBe(false);
  });
});
