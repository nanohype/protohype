import { describe, expect, it } from "vitest";
import { groupUpgrades, type PendingUpgrade } from "../../../src/core/grouping/strategy.js";

const fixtures: PendingUpgrade[] = [
  { pkg: "@aws-sdk/client-s3", fromVersion: "3.0.0", toVersion: "3.1.0", detectedAt: "2026-04-18T00:00:00Z" },
  { pkg: "@aws-sdk/client-dynamodb", fromVersion: "3.0.0", toVersion: "3.1.0", detectedAt: "2026-04-18T00:00:00Z" },
  { pkg: "react", fromVersion: "18.0.0", toVersion: "19.0.0", detectedAt: "2026-04-19T00:00:00Z" },
];

describe("grouping strategy", () => {
  it("per-dep → one group per package", () => {
    const groups = groupUpgrades({ kind: "per-dep" }, fixtures, new Date("2026-04-20T00:00:00Z"));
    expect(groups).toHaveLength(3);
  });

  it("per-family → matches collapse into one group", () => {
    const groups = groupUpgrades(
      { kind: "per-family", pattern: "@aws-sdk/*" },
      fixtures,
      new Date("2026-04-20T00:00:00Z"),
    );
    expect(groups[0]).toHaveLength(2);
    expect(groups[1]).toHaveLength(1);
    expect(groups[1]?.[0]?.pkg).toBe("react");
  });

  it("per-release-window → recent upgrades grouped, stale upgrades individual", () => {
    const now = new Date("2026-04-20T00:00:00Z");
    const groups = groupUpgrades({ kind: "per-release-window", windowDays: 2 }, fixtures, now);
    // All three are within 2 days, so they're all in one window group.
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("empty input → empty output", () => {
    expect(groupUpgrades({ kind: "per-dep" }, [], new Date())).toEqual([]);
  });
});
