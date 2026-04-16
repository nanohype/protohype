import { describe, it, expect } from "vitest";
import {
  canReadConfig,
  canWriteConfig,
  canReadHistory,
  assertSameOrg,
  buildTeamScopeCondition,
} from "./acl.js";
import type { CallerContext } from "./acl.js";

const makeCallerContext = (overrides: Partial<CallerContext> = {}): CallerContext => ({
  callerTeamId: "team-a",
  isPlatformTeam: false,
  orgId: "nanocorp",
  ...overrides,
});

describe("canReadConfig", () => {
  it("allows a team to read its own config", () => {
    const verdict = canReadConfig(makeCallerContext({ callerTeamId: "team-a" }), "team-a");
    expect(verdict.allowed).toBe(true);
  });

  it("allows platform team to read any team's config", () => {
    const verdict = canReadConfig(
      makeCallerContext({ callerTeamId: "platform", isPlatformTeam: true }),
      "team-b"
    );
    expect(verdict.allowed).toBe(true);
  });

  it("denies a non-platform team from reading another team's config", () => {
    const verdict = canReadConfig(makeCallerContext({ callerTeamId: "team-a" }), "team-b");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("team-a");
      expect(verdict.reason).toContain("team-b");
    }
  });
});

describe("canWriteConfig", () => {
  it("allows a team to write its own config", () => {
    const verdict = canWriteConfig(makeCallerContext({ callerTeamId: "team-a" }), "team-a");
    expect(verdict.allowed).toBe(true);
  });

  it("denies platform team from writing another team's config", () => {
    // Platform team has READ-only org-wide visibility, not write
    const verdict = canWriteConfig(
      makeCallerContext({ callerTeamId: "platform", isPlatformTeam: true }),
      "team-b"
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("writes are restricted to the owning team");
    }
  });

  it("denies a different non-platform team from writing config", () => {
    const verdict = canWriteConfig(makeCallerContext({ callerTeamId: "team-a" }), "team-b");
    expect(verdict.allowed).toBe(false);
  });
});

describe("canReadHistory", () => {
  it("follows same rules as canReadConfig", () => {
    const ownHistory = canReadHistory(makeCallerContext({ callerTeamId: "team-a" }), "team-a");
    expect(ownHistory.allowed).toBe(true);

    const crossHistory = canReadHistory(makeCallerContext({ callerTeamId: "team-a" }), "team-b");
    expect(crossHistory.allowed).toBe(false);

    const platformHistory = canReadHistory(
      makeCallerContext({ isPlatformTeam: true }),
      "any-team"
    );
    expect(platformHistory.allowed).toBe(true);
  });
});

describe("assertSameOrg", () => {
  it("allows access within the same org", () => {
    const verdict = assertSameOrg("nanocorp", "nanocorp");
    expect(verdict.allowed).toBe(true);
  });

  it("denies cross-org access", () => {
    const verdict = assertSameOrg("nanocorp", "other-corp");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("Cross-org access denied");
    }
  });
});

describe("buildTeamScopeCondition", () => {
  it("returns a valid DynamoDB condition expression scoped to teamId", () => {
    const condition = buildTeamScopeCondition("team-a");
    expect(condition.keyConditionExpression).toContain("#tid");
    expect(condition.expressionAttributeNames["#tid"]).toBe("teamId");
    expect(condition.expressionAttributeValues[":tid"]).toBe("team-a");
  });
});
