import { describe, it, expect } from "vitest";
import { groupUpgrades, filterEligibleUpgrades } from "../../../src/core/grouping/strategy.js";
import type { DepVersion, UpgradeGroup } from "../../../src/core/grouping/strategy.js";
import type { GroupingStrategy, RepoConfig } from "../../../src/types.js";

const mockRepo: RepoConfig = {
  owner: "acme",
  repo: "backend",
  installationId: 12345,
  watchedDeps: [],
  defaultBranch: "main",
};

const deps: DepVersion[] = [
  { dep: "@aws-sdk/client-s3", fromVersion: "3.100.0", toVersion: "3.200.0" },
  { dep: "@aws-sdk/client-dynamodb", fromVersion: "3.100.0", toVersion: "3.200.0" },
  { dep: "react", fromVersion: "18.0.0", toVersion: "19.0.0" },
  { dep: "next", fromVersion: "13.0.0", toVersion: "14.0.0" },
];

describe("groupUpgrades - per-dep strategy", () => {
  it("creates one group per dependency", () => {
    const strategy: GroupingStrategy = { kind: "per-dep" };
    const groups = groupUpgrades(deps, strategy, mockRepo);

    expect(groups).toHaveLength(4);
    groups.forEach((g) => {
      expect(g.deps).toHaveLength(1);
    });
  });

  it("group IDs include dep name and version", () => {
    const strategy: GroupingStrategy = { kind: "per-dep" };
    const groups = groupUpgrades(deps, strategy, mockRepo);
    const reactGroup = groups.find((g) => g.deps[0]?.dep === "react");
    expect(reactGroup?.groupId).toBe("react@19.0.0");
  });
});

describe("groupUpgrades - per-family strategy", () => {
  it("consolidates matching deps into one family group", () => {
    const strategy: GroupingStrategy = { kind: "per-family", pattern: "@aws-sdk/*" };
    const groups = groupUpgrades(deps, strategy, mockRepo);

    // Should have 1 family group + 2 solo groups (react, next)
    expect(groups).toHaveLength(3);

    const familyGroup = groups.find((g) => g.groupId.startsWith("family:"));
    expect(familyGroup).toBeDefined();
    expect(familyGroup!.deps).toHaveLength(2);
    expect(familyGroup!.deps.map((d) => d.dep)).toContain("@aws-sdk/client-s3");
    expect(familyGroup!.deps.map((d) => d.dep)).toContain("@aws-sdk/client-dynamodb");
  });

  it("groups correctly verify: exactly ONE consolidated PR for family", () => {
    const strategy: GroupingStrategy = { kind: "per-family", pattern: "@aws-sdk/*" };
    const groups = groupUpgrades(deps, strategy, mockRepo);
    const familyGroups = groups.filter((g) => g.groupId.startsWith("family:"));

    // Kiln opens exactly one consolidated PR per family per release window
    expect(familyGroups).toHaveLength(1);
  });

  it("does not match non-family deps into the family group", () => {
    const strategy: GroupingStrategy = { kind: "per-family", pattern: "@aws-sdk/*" };
    const groups = groupUpgrades(deps, strategy, mockRepo);
    const familyGroup = groups.find((g) => g.groupId.startsWith("family:"))!;
    const familyDepNames = familyGroup.deps.map((d) => d.dep);

    expect(familyDepNames).not.toContain("react");
    expect(familyDepNames).not.toContain("next");
  });

  it("handles @types/* family pattern", () => {
    const typesDeps: DepVersion[] = [
      { dep: "@types/node", fromVersion: "20.0.0", toVersion: "24.0.0" },
      { dep: "@types/react", fromVersion: "18.0.0", toVersion: "19.0.0" },
      { dep: "lodash", fromVersion: "4.17.20", toVersion: "4.17.21" },
    ];
    const strategy: GroupingStrategy = { kind: "per-family", pattern: "@types/*" };
    const groups = groupUpgrades(typesDeps, strategy, mockRepo);

    const familyGroup = groups.find((g) => g.groupId.startsWith("family:"))!;
    expect(familyGroup.deps).toHaveLength(2);

    const soloGroups = groups.filter((g) => !g.groupId.startsWith("family:"));
    expect(soloGroups).toHaveLength(1);
    expect(soloGroups[0]?.deps[0]?.dep).toBe("lodash");
  });
});

describe("groupUpgrades - per-release-window strategy", () => {
  it("puts all upgrades into a single group", () => {
    const strategy: GroupingStrategy = { kind: "per-release-window", windowDays: 7 };
    const groups = groupUpgrades(deps, strategy, mockRepo);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.deps).toHaveLength(4);
  });

  it("returns empty array for empty input", () => {
    const strategy: GroupingStrategy = { kind: "per-release-window", windowDays: 7 };
    const groups = groupUpgrades([], strategy, mockRepo);
    expect(groups).toHaveLength(0);
  });
});

describe("filterEligibleUpgrades", () => {
  it("removes pinned-skip deps", () => {
    const filtered = filterEligibleUpgrades(deps, ["react"]);
    expect(filtered.map((d) => d.dep)).not.toContain("react");
    expect(filtered).toHaveLength(3);
  });

  it("removes deps already on target version", () => {
    const depsWithDupe: DepVersion[] = [
      ...deps,
      { dep: "lodash", fromVersion: "4.17.21", toVersion: "4.17.21" }, // same version
    ];
    const filtered = filterEligibleUpgrades(depsWithDupe, []);
    expect(filtered.find((d) => d.dep === "lodash")).toBeUndefined();
  });

  it("returns all deps when no pins and no same-version entries", () => {
    const filtered = filterEligibleUpgrades(deps, []);
    expect(filtered).toHaveLength(4);
  });
});
