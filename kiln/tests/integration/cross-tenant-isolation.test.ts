// Proves that tenant scoping is enforced at the data layer: team A's reads
// can never observe team B's writes via any port method. This test catches
// the class of bug where "we added a query but forgot the partition scope."

import { beforeAll, expect, it } from "vitest";
import { adaptersAgainstLocal, buildDocClient, integrationDescribe } from "./shared.js";
import { asInstallationId, asTeamId, asUpgradeId, type TeamConfig } from "../../src/types.js";

const teamA: TeamConfig = {
  teamId: asTeamId("team-a"),
  orgId: "org-a",
  repos: [
    { owner: "acme", repo: "app-a", installationId: asInstallationId(1), watchedDeps: ["react"] },
  ],
  targetVersionPolicy: "latest",
  reviewSlaDays: 7,
  slackChannel: null,
  linearProjectId: null,
  groupingStrategy: { kind: "per-dep" },
  pinnedSkipList: [],
  createdAt: "2026-04-20T00:00:00Z",
  updatedAt: "2026-04-20T00:00:00Z",
};
const teamB: TeamConfig = { ...teamA, teamId: asTeamId("team-b"), orgId: "org-b" };

integrationDescribe("cross-tenant isolation", () => {
  let adapters: ReturnType<typeof adaptersAgainstLocal>;

  beforeAll(() => {
    adapters = adaptersAgainstLocal(buildDocClient());
  });

  it("teamConfig.get returns null for a team that doesn't exist (no silent cross-read)", async () => {
    await adapters.teamConfig.put(teamA);
    const result = await adapters.teamConfig.get(teamB.teamId);
    expect(result.ok && result.value).toBeNull();
  });

  it("prLedger.findExistingPr scoped on teamId: team B can't see team A's PRs", async () => {
    await adapters.prLedger.recordPrOpened(
      {
        teamId: teamA.teamId,
        repo: "acme/app-a",
        pkg: "react",
        fromVersion: "18.0.0",
        toVersion: "19.0.0",
      },
      {
        owner: "acme",
        repo: "app-a",
        number: 42,
        url: "https://github.com/acme/app-a/pull/42",
        headSha: "abc",
      },
      asUpgradeId("u-1"),
    );

    const asTeamB = await adapters.prLedger.findExistingPr({
      teamId: teamB.teamId,
      repo: "acme/app-a",
      pkg: "react",
      fromVersion: "18.0.0",
      toVersion: "19.0.0",
    });
    expect(asTeamB.ok && asTeamB.value).toBeNull();

    const asTeamA = await adapters.prLedger.findExistingPr({
      teamId: teamA.teamId,
      repo: "acme/app-a",
      pkg: "react",
      fromVersion: "18.0.0",
      toVersion: "19.0.0",
    });
    expect(asTeamA.ok && asTeamA.value?.number).toBe(42);
  });

  it("prLedger.listRecent returns only the caller's team", async () => {
    const a = await adapters.prLedger.listRecent(teamA.teamId, 100);
    const b = await adapters.prLedger.listRecent(teamB.teamId, 100);
    expect(a.ok && a.value.every((r) => r.teamId === teamA.teamId)).toBe(true);
    expect(b.ok && b.value.length).toBe(0);
  });
});
