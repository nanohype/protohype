import { describe, it, expect } from "vitest";
import { groupUpdates } from "./strategy.js";
import type { DepUpdate, GroupingStrategy } from "./types.js";

const makeUpdate = (
  packageName: string,
  toVersion: string,
  publishedAt = "2024-03-15T12:00:00Z"
): DepUpdate => ({
  packageName,
  fromVersion: "1.0.0",
  toVersion,
  publishedAt,
});

describe("groupUpdates — per-dep strategy", () => {
  const strategy: GroupingStrategy = { type: "per-dep" };

  it("returns one group per update", () => {
    const updates = [
      makeUpdate("react", "19.0.0"),
      makeUpdate("next", "15.0.0"),
    ];
    const groups = groupUpdates(updates, strategy);
    expect(groups).toHaveLength(2);
  });

  it("each group contains exactly one update", () => {
    const updates = [makeUpdate("zod", "4.0.0"), makeUpdate("vitest", "4.0.0")];
    const groups = groupUpdates(updates, strategy);
    for (const g of groups) {
      expect(g.updates).toHaveLength(1);
    }
  });

  it("returns empty array for empty input", () => {
    expect(groupUpdates([], strategy)).toEqual([]);
  });

  it("group label includes package name and version", () => {
    const groups = groupUpdates([makeUpdate("typescript", "6.0.0")], strategy);
    expect(groups[0].label).toContain("typescript");
    expect(groups[0].label).toContain("6.0.0");
  });

  it("group IDs are URL-safe slugs", () => {
    const groups = groupUpdates([makeUpdate("@aws-sdk/client-s3", "3.0.0")], strategy);
    expect(groups[0].groupId).toMatch(/^[a-z0-9@._-]+$/);
  });
});

describe("groupUpdates — per-family strategy", () => {
  const strategy: GroupingStrategy = { type: "per-family", pattern: "@aws-sdk/*" };

  const updates = [
    makeUpdate("@aws-sdk/client-s3", "3.100.0"),
    makeUpdate("@aws-sdk/client-dynamodb", "3.100.0"),
    makeUpdate("@aws-sdk/lib-dynamodb", "3.100.0"),
    makeUpdate("react", "19.0.0"),
  ];

  it("consolidates matching packages into a single group", () => {
    const groups = groupUpdates(updates, strategy);
    const familyGroups = groups.filter((g) => g.label.includes("@aws-sdk"));
    expect(familyGroups).toHaveLength(1);
    expect(familyGroups[0].updates).toHaveLength(3);
  });

  it("non-matching packages get their own groups", () => {
    const groups = groupUpdates(updates, strategy);
    const reactGroup = groups.find((g) => g.label.includes("react"));
    expect(reactGroup).toBeDefined();
    expect(reactGroup?.updates).toHaveLength(1);
  });

  it("total groups = 1 family + N non-family updates", () => {
    const groups = groupUpdates(updates, strategy);
    expect(groups).toHaveLength(2); // 1 family group + 1 react
  });

  it("family group contains all matching updates", () => {
    const groups = groupUpdates(updates, strategy);
    const family = groups.find((g) => g.updates.length > 1)!;
    const names = family.updates.map((u) => u.packageName);
    expect(names).toContain("@aws-sdk/client-s3");
    expect(names).toContain("@aws-sdk/client-dynamodb");
    expect(names).toContain("@aws-sdk/lib-dynamodb");
  });

  it("handles pattern with no matching packages (all solo)", () => {
    const noMatch = [makeUpdate("react", "19.0.0"), makeUpdate("next", "15.0.0")];
    const groups = groupUpdates(noMatch, { type: "per-family", pattern: "@aws-sdk/*" });
    expect(groups).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(groupUpdates([], strategy)).toEqual([]);
  });
});

describe("groupUpdates — per-release-window strategy", () => {
  const strategy: GroupingStrategy = { type: "per-release-window", windowDays: 7 };

  it("groups updates published in the same 7-day window", () => {
    const updates = [
      makeUpdate("react", "19.0.0", "2024-03-01T00:00:00Z"),
      makeUpdate("next", "15.0.0", "2024-03-03T00:00:00Z"), // same window
      makeUpdate("zod", "4.0.0", "2024-03-15T00:00:00Z"), // different window
    ];
    const groups = groupUpdates(updates, strategy);
    expect(groups).toHaveLength(2);

    const reactNextGroup = groups.find((g) => g.updates.length === 2);
    expect(reactNextGroup).toBeDefined();
    expect(reactNextGroup!.updates.map((u) => u.packageName)).toContain("react");
    expect(reactNextGroup!.updates.map((u) => u.packageName)).toContain("next");
  });

  it("each update in its own window gets its own group", () => {
    const updates = [
      makeUpdate("a", "1.0.0", "2024-01-01T00:00:00Z"),
      makeUpdate("b", "1.0.0", "2024-02-01T00:00:00Z"),
      makeUpdate("c", "1.0.0", "2024-03-01T00:00:00Z"),
    ];
    const groups = groupUpdates(updates, strategy);
    expect(groups).toHaveLength(3);
  });

  it("throws on windowDays <= 0", () => {
    expect(() =>
      groupUpdates([makeUpdate("a", "1.0.0")], { type: "per-release-window", windowDays: 0 })
    ).toThrow("windowDays must be a positive integer");
  });

  it("throws on invalid publishedAt timestamp", () => {
    expect(() =>
      groupUpdates(
        [makeUpdate("a", "1.0.0", "not-a-date")],
        { type: "per-release-window", windowDays: 7 }
      )
    ).toThrow(/Invalid publishedAt timestamp/);
  });

  it("group label includes window start date", () => {
    const updates = [makeUpdate("react", "19.0.0", "2024-03-15T00:00:00Z")];
    const groups = groupUpdates(updates, strategy);
    expect(groups[0].label).toMatch(/Release window \d{4}-\d{2}-\d{2}/);
  });
});
