// Upgrader — processes one SQS message at a time. Idempotent: checks the PR
// ledger before doing any work, skips if a PR already exists for the key.
//
// Pipeline:
//   1. Idempotency check in PR ledger
//   2. Rate-limiter acquire (DDB-backed token bucket, scoped per team)
//   3. Changelog fetch (cached) + classify via Haiku
//   4. Code search per breaking change
//   5. Synthesize patches via Sonnet (escalate to Opus on low confidence)
//   6. Open PR via GitHub App
//   7. Record in PR ledger + close audit record
//
// Every step between audit records is `await`ed. No fire-and-forget.

import { extractRangeSections } from "../core/changelog/parser.js";
import { advance, newAuditRecord, withError, withPr } from "../core/audit/shape.js";
import { idempotencyDigest } from "../core/github/idempotency.js";
import { renderBranchName, renderPrBody, renderPrTitle } from "../core/github/pr-body.js";
import type { Ports } from "../core/ports.js";
import type { Config } from "../config.js";
import { metrics, MetricNames } from "../telemetry/metrics.js";
import { withSpan } from "../telemetry/tracing.js";
import type { AuditRecord, PrIdempotencyKey, Result, UpgradeJob } from "../types.js";

export interface UpgradeOutcome {
  kind: "pr-opened" | "skipped" | "failed";
  message?: string;
}

export async function runUpgrader(
  ports: Ports,
  config: Config,
  job: UpgradeJob,
): Promise<UpgradeOutcome> {
  const teamDim = [{ name: "team_id", value: String(job.teamId) }];
  const started = Date.now();
  const outcome = await withSpan(
    "kiln.upgrader.run",
    () => runUpgraderInner(ports, config, job),
    {
      "kiln.team_id": String(job.teamId),
      "kiln.upgrade_id": String(job.upgradeId),
      "kiln.pkg": job.pkg,
      "kiln.from_version": job.fromVersion,
      "kiln.to_version": job.toVersion,
    },
  );
  metrics.durationMs(MetricNames.UpgraderTotalDurationMs, Date.now() - started, [
    ...teamDim,
    { name: "outcome", value: outcome.kind },
  ]);
  switch (outcome.kind) {
    case "pr-opened":
      metrics.increment(MetricNames.PrOpenedCount, teamDim);
      break;
    case "skipped":
      metrics.increment(MetricNames.UpgradeSkippedCount, [
        ...teamDim,
        { name: "reason", value: outcome.message ?? "unknown" },
      ]);
      break;
    case "failed":
      metrics.increment(MetricNames.UpgradeFailedCount, [
        ...teamDim,
        { name: "reason", value: outcome.message ?? "unknown" },
      ]);
      if (outcome.message === "ledger-desync") metrics.increment(MetricNames.LedgerDesyncCount, teamDim);
      break;
  }
  return outcome;
}

async function runUpgraderInner(
  ports: Ports,
  config: Config,
  job: UpgradeJob,
): Promise<UpgradeOutcome> {
  const log = ports.logger.child({
    worker: "upgrader",
    teamId: job.teamId,
    upgradeId: job.upgradeId,
    pkg: job.pkg,
  });

  const key: PrIdempotencyKey = {
    teamId: job.teamId,
    repo: `${job.repo.owner}/${job.repo.name}`,
    pkg: job.pkg,
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
  };

  // 1. Idempotency — don't re-open.
  const existing = await ports.prLedger.findExistingPr(key);
  if (existing.ok && existing.value) {
    log.info("PR already opened for this upgrade, skipping", { pr: existing.value.url });
    return { kind: "skipped", message: "duplicate" };
  }

  // 2. Rate limiter.
  const bucketKey = `github:${job.teamId}`;
  const tokenTaken = await ports.rate.tryAcquire(
    bucketKey,
    config.github.rateCapacity,
    config.github.rateRefillPerSec,
  );
  if (!tokenTaken) {
    log.warn("rate limited, will retry via SQS redelivery");
    metrics.increment(MetricNames.RateLimiterRejectCount, [
      { name: "team_id", value: String(job.teamId) },
    ]);
    return { kind: "failed", message: "rate-limited" };
  }

  const now = ports.clock.now();
  let audit: AuditRecord = newAuditRecord(
    job.teamId,
    job.upgradeId,
    job.pkg,
    job.fromVersion,
    job.toVersion,
    now,
  );
  await ports.audit.putUpgradeRecord(audit);

  try {
    // 3. Changelog.
    audit = advance(audit, "classifying", ports.clock.now());
    await ports.audit.putUpgradeRecord(audit);

    const cacheKey = `${job.pkg}@${job.toVersion}`;
    let changelogBody: string | null = null;
    const cached = await ports.changelogCache.get(cacheKey);
    if (cached) {
      changelogBody = cached.body;
    } else {
      const manifest = await ports.npm.getVersionManifest(job.pkg, job.toVersion);
      if (manifest.ok && manifest.value.repository) {
        const url = normalizeChangelogUrl(manifest.value.repository);
        if (url) {
          const fetched = await ports.changelog.fetch(url);
          if (fetched.ok && fetched.value) {
            changelogBody = fetched.value.body;
            await ports.changelogCache.put(cacheKey, changelogBody, 7 * 24 * 3600);
          }
        }
      }
    }

    if (!changelogBody) {
      const failed = withError(audit, "no changelog found", ports.clock.now());
      await ports.audit.putUpgradeRecord(failed);
      return { kind: "failed", message: "no-changelog" };
    }

    const sections = extractRangeSections(changelogBody, job.fromVersion, job.toVersion);
    const truncated = sections.map((s) => `## ${s.version}\n${s.body}`).join("\n\n");

    const classifyStart = Date.now();
    const classification = await withSpan("kiln.classify", () =>
      ports.llm.classify({
        pkg: job.pkg,
        fromVersion: job.fromVersion,
        toVersion: job.toVersion,
        changelogBody: truncated || changelogBody,
      }),
    );
    metrics.durationMs(MetricNames.ClassifyDurationMs, Date.now() - classifyStart, [
      { name: "outcome", value: classification.ok ? "ok" : "error" },
    ]);
    if (!classification.ok) {
      const failed = withError(audit, `classify: ${classification.error.message}`, ports.clock.now());
      await ports.audit.putUpgradeRecord(failed);
      return { kind: "failed", message: "classify-failed" };
    }
    metrics.count(
      MetricNames.BreakingChangeClassifiedCount,
      classification.value.breakingChanges.length,
      [{ name: "pkg", value: job.pkg }],
    );

    // 4. Code search per breaking change.
    audit = advance(audit, "scanning", ports.clock.now());
    await ports.audit.putUpgradeRecord(audit);

    const allCallSites = [];
    for (const bc of classification.value.breakingChanges) {
      const sites = await ports.codeSearch.searchImportSites(
        job.repo.installationId,
        job.repo.owner,
        job.repo.name,
        job.pkg,
        bc.affectedSymbols,
      );
      if (sites.ok) allCallSites.push(...sites.value);
    }

    // 5. Synthesize.
    audit = advance(audit, "synthesizing", ports.clock.now());
    await ports.audit.putUpgradeRecord(audit);

    const synthStart = Date.now();
    const allPatches = [];
    const allWarnings: string[] = [];
    for (const bc of classification.value.breakingChanges) {
      const relevant = allCallSites.filter((cs) =>
        bc.affectedSymbols.some((s) => cs.symbol === s),
      );
      if (relevant.length === 0) continue;
      const model =
        classification.value.confidence < 0.7 ? "synthesizer-escalation" : "synthesizer";
      if (model === "synthesizer-escalation") {
        metrics.increment(MetricNames.ClassifierEscalationCount, [{ name: "pkg", value: job.pkg }]);
      }
      const synth = await withSpan(
        "kiln.synthesize",
        () =>
          ports.llm.synthesize(
            { pkg: job.pkg, fromVersion: job.fromVersion, toVersion: job.toVersion, breakingChange: bc, callSites: relevant },
            model,
          ),
        { "kiln.breaking_change": bc.title, "kiln.synthesizer_model": model },
      );
      if (!synth.ok) {
        allWarnings.push(`synthesis failed for ${bc.title}: ${synth.error.message}`);
        continue;
      }
      allPatches.push(...synth.value.patches);
      allWarnings.push(...synth.value.warnings);
    }
    metrics.durationMs(MetricNames.SynthesizeDurationMs, Date.now() - synthStart, [
      { name: "pkg", value: job.pkg },
    ]);

    if (allPatches.length === 0) {
      const failed = withError(audit, "no patches synthesized", ports.clock.now());
      await ports.audit.putUpgradeRecord(failed);
      return { kind: "failed", message: "no-patches" };
    }

    // 6. Open PR.
    const body = renderPrBody({
      pkg: job.pkg,
      fromVersion: job.fromVersion,
      toVersion: job.toVersion,
      summary: classification.value.summary,
      breakingChanges: classification.value.breakingChanges,
      patches: allPatches,
      callSites: allCallSites,
      modelsUsed: {
        classifier: config.bedrock.classifierModel,
        synthesizer: config.bedrock.synthesizerModel,
      },
      warnings: allWarnings,
    });

    const headBranch = renderBranchName(job.pkg, job.toVersion);
    const prStart = Date.now();
    const pr = await withSpan(
      "kiln.pr_open",
      () =>
        ports.github.openPullRequest(job.repo.installationId, {
          owner: job.repo.owner,
          repo: job.repo.name,
          baseBranch: "main",
          headBranch,
          title: renderPrTitle(job.pkg, job.fromVersion, job.toVersion),
          body,
          files: allPatches,
        }),
      { "kiln.head_branch": headBranch, "kiln.repo": `${job.repo.owner}/${job.repo.name}` },
    );
    metrics.durationMs(MetricNames.PrOpenDurationMs, Date.now() - prStart, [
      { name: "outcome", value: pr.ok ? "ok" : "error" },
    ]);
    if (!pr.ok) {
      const failed = withError(audit, `open PR: ${pr.error.message}`, ports.clock.now());
      await ports.audit.putUpgradeRecord(failed);
      return { kind: "failed", message: "pr-open-failed" };
    }

    // 7. Ledger + audit.
    // The PR is already open on GitHub — we MUST get it recorded in the ledger
    // or a retry of this message will open a duplicate. Retry with backoff,
    // and if we still can't write, flag a ledger-desync so an operator can
    // reconcile before the SQS dedup window (5min) expires.
    const recorded = await retryWrite(() => ports.prLedger.recordPrOpened(key, pr.value, job.upgradeId), {
      attempts: 3,
      baseDelayMs: 200,
      acceptableErrorKinds: ["Conflict"],
    });

    if (!recorded.ok && recorded.error.kind !== "Conflict") {
      // The PR exists on GitHub. Include its ref in the audit record so
      // operators can reconcile manually via the runbook.
      const desync = withError(
        { ...audit, prRef: pr.value },
        `ledger-desync: PR opened at ${pr.value.url} but ledger write failed — ${recorded.error.message}`,
        ports.clock.now(),
      );
      await ports.audit.putUpgradeRecord(desync);
      log.error("LEDGER_DESYNC — PR opened but ledger write failed after retries", {
        pr: pr.value.url,
        digest: idempotencyDigest(key).slice(0, 12),
        error: recorded.error,
        alert: "ledger-desync",
      });
      return { kind: "failed", message: "ledger-desync" };
    }

    const closed = withPr(audit, pr.value, ports.clock.now());
    await ports.audit.putUpgradeRecord(closed);

    if (config.notifications.slackWebhookUrl) {
      const notified = await ports.notifications.postPrOpened(
        "",
        job.teamId,
        pr.value,
        classification.value.summary,
      );
      if (!notified.ok) {
        // Notification failure is non-critical; the audit ledger is the
        // authoritative record. Log and keep going.
        log.warn("slack notification failed", { error: notified.error, pr: pr.value.url });
      }
    }

    log.info("PR opened", { pr: pr.value.url, digest: idempotencyDigest(key).slice(0, 12) });
    return { kind: "pr-opened" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failed = withError(audit, message, ports.clock.now());
    await ports.audit.putUpgradeRecord(failed);
    log.error("upgrader failed", { error: message });
    return { kind: "failed", message };
  }
}

interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  /** Error kinds that should short-circuit the retry loop (e.g., Conflict = already succeeded). */
  acceptableErrorKinds: ReadonlyArray<string>;
}

async function retryWrite<T, E extends { kind: string; message: string }>(
  fn: () => Promise<Result<T, E>>,
  opts: RetryOptions,
): Promise<Result<T, E>> {
  let last: Result<T, E> = await fn();
  for (let attempt = 1; attempt < opts.attempts; attempt++) {
    if (last.ok) return last;
    if (opts.acceptableErrorKinds.includes(last.error.kind)) return last;
    await new Promise((r) => setTimeout(r, opts.baseDelayMs * 2 ** (attempt - 1)));
    last = await fn();
  }
  return last;
}

function normalizeChangelogUrl(repoField: string): string | null {
  // Common npm repository fields: "git+https://github.com/owner/repo.git",
  // "https://github.com/owner/repo", "github:owner/repo".
  const githubMatch = /(?:github\.com\/|github:)([^/]+)\/([^/.#]+)/.exec(repoField);
  if (!githubMatch) return null;
  const owner = githubMatch[1];
  const repo = githubMatch[2];
  if (!owner || !repo) return null;
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/CHANGELOG.md`;
}
