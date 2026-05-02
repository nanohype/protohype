// Poller — scheduled every N minutes. For each team, for each watched dep,
// asks npm for the latest, filters through the policy + skip list, enqueues
// an upgrade job per eligible dep. FIFO dedup collapses same-version retries.

import { randomUUID } from "node:crypto";
import { isEligibleUpgrade, isSkipped } from "../core/npm/policy.js";
import type { LoggerPort, Ports } from "../core/ports.js";
import { metrics as otelMetrics, MetricNames } from "../telemetry/metrics.js";
import { withSpan } from "../telemetry/tracing.js";
import { asUpgradeId, type TeamConfig, type UpgradeJob } from "../types.js";

export interface PollerMetrics {
  teamsScanned: number;
  depsChecked: number;
  enqueued: number;
  skipped: number;
  errors: number;
}

export async function runPoller(ports: Ports): Promise<PollerMetrics> {
  const start = Date.now();
  const result = await withSpan("kiln.poller.cycle", () => runPollerInner(ports));
  otelMetrics.durationMs(MetricNames.PollerCycleDurationMs, Date.now() - start);
  otelMetrics.count(MetricNames.PollerEnqueuedCount, result.enqueued);
  otelMetrics.count(MetricNames.PollerScannedCount, result.depsChecked);
  return result;
}

async function runPollerInner(ports: Ports): Promise<PollerMetrics> {
  const log = ports.logger.child({ worker: "poller" });
  const result: PollerMetrics = {
    teamsScanned: 0,
    depsChecked: 0,
    enqueued: 0,
    skipped: 0,
    errors: 0,
  };

  const teamsResult = await ports.teamConfig.list();
  if (!teamsResult.ok) {
    log.error("failed to list teams", { error: teamsResult.error });
    result.errors++;
    return result;
  }

  for (const team of teamsResult.value) {
    result.teamsScanned++;
    await scanTeam(ports, team, result, log);
  }

  log.info("poll cycle complete", { ...result });
  return result;
}

async function scanTeam(
  ports: Ports,
  team: TeamConfig,
  result: PollerMetrics,
  log: LoggerPort,
): Promise<void> {
  // Each (repo, pkg) is independent; we don't parallelize here to keep the
  // poller's npm request volume predictable.
  for (const repo of team.repos) {
    for (const pkg of repo.watchedDeps) {
      result.depsChecked++;
      if (isSkipped(pkg, team.pinnedSkipList)) {
        result.skipped++;
        continue;
      }
      const latest = await ports.npm.getLatestVersion(pkg);
      if (!latest.ok) {
        log.warn("npm lookup failed", { pkg, error: latest.error });
        result.errors++;
        continue;
      }
      // TODO v1.1 — resolve current version from repo package.json.
      // For v1 we trust the candidate upgrade against a policy-minimum; the PR
      // ledger's idempotency key will prevent re-opening the same PR.
      const currentVersion = "0.0.0";
      if (!isEligibleUpgrade(currentVersion, latest.value.version, team.targetVersionPolicy)) {
        result.skipped++;
        continue;
      }
      const job: UpgradeJob = {
        teamId: team.teamId,
        upgradeId: asUpgradeId(randomUUID()),
        repo: { owner: repo.owner, name: repo.repo, installationId: repo.installationId },
        pkg,
        fromVersion: currentVersion,
        toVersion: latest.value.version,
        enqueuedAt: ports.clock.now().toISOString(),
        groupKey: `${team.teamId}:${repo.owner}/${repo.repo}:${pkg}`,
      };
      const enq = await ports.queue.enqueue(job);
      if (!enq.ok) {
        log.warn("enqueue failed", { pkg, error: enq.error });
        result.errors++;
        continue;
      }
      result.enqueued++;
    }
  }
}
