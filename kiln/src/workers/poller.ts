/**
 * npm registry poller — watches deps for new versions and enqueues upgrade jobs.
 * Runs on an interval; graceful shutdown on SIGTERM.
 */
import { fetchLatestVersion, compareSemver } from "../core/npm/registry.js";
import { getDocumentClient } from "../db/client.js";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "../config.js";
import { log, withSpan } from "../telemetry/otel.js";
import type { TeamConfig, RepoConfig } from "../types.js";
import { runUpgradePipeline } from "./upgrader.js";
import { groupUpgrades, filterEligibleUpgrades } from "../core/grouping/strategy.js";

// Track last-seen versions in memory (poller is single-instance)
const lastSeenVersions = new Map<string, string>(); // dep → version

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

export function startPoller(): void {
  if (isRunning) return;
  isRunning = true;
  log("info", "npm poller starting", { intervalMs: config.npm.pollIntervalMs });
  schedulePoll();
}

export function stopPoller(): void {
  isRunning = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  log("info", "npm poller stopped");
}

function schedulePoll(): void {
  if (!isRunning) return;
  pollTimer = setTimeout(async () => {
    await runPollCycle();
    schedulePoll();
  }, config.npm.pollIntervalMs);
}

async function runPollCycle(): Promise<void> {
  await withSpan("poll-cycle", async () => {
    log("info", "Poll cycle starting");

    const teamConfigs = await loadAllTeamConfigs();
    log("info", "Loaded team configs for polling", { count: teamConfigs.length });

    for (const teamConfig of teamConfigs) {
      await pollTeam(teamConfig);
    }

    log("info", "Poll cycle complete");
  });
}

async function pollTeam(teamConfig: TeamConfig): Promise<void> {
  const { teamId, repos, pinnedSkipList, groupingStrategy, targetVersionPolicy } = teamConfig;

  for (const repoConfig of repos) {
    const depUpgrades = await detectUpgradesForRepo(
      repoConfig,
      pinnedSkipList,
      targetVersionPolicy,
    );

    if (depUpgrades.length === 0) continue;

    const eligibleUpgrades = filterEligibleUpgrades(depUpgrades, pinnedSkipList);
    const groups = groupUpgrades(eligibleUpgrades, groupingStrategy, repoConfig);

    for (const group of groups) {
      // Run upgrade pipeline for each group
      // In production this would be enqueued to SQS for fan-out; for v1 we run inline
      for (const dep of group.deps) {
        try {
          await runUpgradePipeline({
            teamId,
            repoConfig,
            dep: dep.dep,
            fromVersion: dep.fromVersion,
            toVersion: dep.toVersion,
            groupId: group.groupId,
          });
        } catch (err) {
          log("error", "Upgrade pipeline error in poller", {
            teamId,
            dep: dep.dep,
            error: String(err),
          });
        }
      }
    }
  }
}

async function detectUpgradesForRepo(
  repoConfig: RepoConfig,
  pinnedSkipList: string[],
  targetVersionPolicy: TeamConfig["targetVersionPolicy"],
): Promise<Array<{ dep: string; fromVersion: string; toVersion: string }>> {
  const upgrades: Array<{ dep: string; fromVersion: string; toVersion: string }> = [];

  for (const dep of repoConfig.watchedDeps) {
    if (pinnedSkipList.includes(dep)) continue;

    try {
      const info = await fetchLatestVersion(dep);
      const lastSeen = lastSeenVersions.get(dep);

      if (!lastSeen) {
        // First time seeing this dep — record current version, don't trigger upgrade
        lastSeenVersions.set(dep, info.latestVersion);
        continue;
      }

      if (compareSemver(info.latestVersion, lastSeen) <= 0) continue; // no new version

      // Check policy
      if (targetVersionPolicy === "patch-only") {
        const [lMaj, lMin] = info.latestVersion.split(".").map(Number);
        const [sMaj, sMin] = lastSeen.split(".").map(Number);
        if (lMaj !== sMaj || lMin !== sMin) continue; // skip non-patch upgrades
      } else if (targetVersionPolicy === "minor-only") {
        const [lMaj] = info.latestVersion.split(".").map(Number);
        const [sMaj] = lastSeen.split(".").map(Number);
        if (lMaj !== sMaj) continue; // skip major upgrades
      }

      log("info", "New version detected", { dep, from: lastSeen, to: info.latestVersion });
      upgrades.push({ dep, fromVersion: lastSeen, toVersion: info.latestVersion });
      lastSeenVersions.set(dep, info.latestVersion);
    } catch (err) {
      log("warn", "Version check failed for dep", { dep, err: String(err) });
    }
  }

  return upgrades;
}

async function loadAllTeamConfigs(): Promise<TeamConfig[]> {
  const client = getDocumentClient();
  // Full scan — poller has platform-level access
  const { Items = [] } = await client.send(
    new QueryCommand({
      TableName: config.dynamodb.teamsTable,
      Select: "ALL_ATTRIBUTES",
      KeyConditionExpression: undefined as never,
    }),
  );
  return Items as TeamConfig[];
}
