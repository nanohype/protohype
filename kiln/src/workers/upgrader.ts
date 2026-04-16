/**
 * Main upgrade pipeline worker.
 * Orchestrates: npm polling → changelog fetch → Bedrock classification
 * → codebase scan → Bedrock migration synthesis → PR creation.
 *
 * Runs as a cron-triggered worker. Each invocation processes one upgrade group.
 * Graceful shutdown on SIGTERM — finishes current job before exiting.
 */
import { randomUUID } from "crypto";
import { fetchChangelog, resolveChangelogUrls } from "../core/changelog/fetcher.js";
import { extractVersionSection, hasPotentialBreakingChanges } from "../core/changelog/parser.js";
import { classifyChangelog, synthesizeMigration } from "../core/bedrock/client.js";
import { scanUsageSites } from "../core/codebase/scanner.js";
import { getInstallationToken } from "../core/github/app.js";
import { createUpgradePR } from "../core/github/pr.js";
import { getCachedChangelog, putChangelogCache } from "../db/changelogs.js";
import { putUpgradeRecord, updateUpgradeStatus } from "../db/upgrades.js";
import { log, withSpan } from "../telemetry/otel.js";
import type { TeamConfig, UpgradeRecord, BreakingChange, PatchedFile, HumanReviewItem } from "../types.js";

export interface UpgradeJob {
  teamId: string;
  repoConfig: TeamConfig["repos"][number];
  dep: string;
  fromVersion: string;
  toVersion: string;
  groupId: string | null;
}

/**
 * Run the full upgrade pipeline for a single dep → PR.
 * Returns the created upgrade record.
 */
export async function runUpgradePipeline(job: UpgradeJob): Promise<UpgradeRecord> {
  const upgradeId = randomUUID();
  const { teamId, repoConfig, dep, fromVersion, toVersion, groupId } = job;

  const record: UpgradeRecord = {
    upgradeId,
    teamId,
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    dep,
    fromVersion,
    toVersion,
    groupId,
    status: "pending",
    prNumber: null,
    prUrl: null,
    changelogUrls: [],
    breakingChanges: [],
    patchedFiles: [],
    humanReviewItems: [],
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Awaited audit write — no fire-and-forget
  await putUpgradeRecord(record);

  try {
    return await withSpan("upgrade-pipeline", async () => {
      // ── Step 1: Fetch changelog ──────────────────────────────────────────
      log("info", "Starting upgrade pipeline", { teamId, dep, fromVersion, toVersion });

      let breakingChanges: BreakingChange[] = [];
      let changelogUrls: string[] = [];

      const cached = await getCachedChangelog(dep, toVersion);
      if (cached) {
        log("info", "Changelog cache hit", { dep, toVersion });
        breakingChanges = cached.breakingChanges;
        changelogUrls = [cached.sourceUrl];
      } else {
        const resolvedUrls = await resolveChangelogUrls(dep, toVersion);
        changelogUrls = resolvedUrls;

        await updateUpgradeStatus(teamId, upgradeId, "changelog-fetched", { changelogUrls });

        // Try each URL until we get content
        let rawChangelog: string | null = null;
        let usedUrl = "";
        for (const url of resolvedUrls) {
          try {
            rawChangelog = await fetchChangelog(url);
            if (rawChangelog) { usedUrl = url; break; }
          } catch (err) {
            log("warn", "Changelog fetch failed — trying next URL", { url, err: String(err) });
          }
        }

        if (!rawChangelog) {
          log("warn", "No changelog content found — skipping breaking change analysis", { dep });
        } else {
          // ── Step 2: Classify for breaking changes ────────────────────────
          const section = extractVersionSection(rawChangelog, fromVersion, toVersion);

          if (!hasPotentialBreakingChanges(section)) {
            log("info", "Heuristic: no breaking changes — skipping Bedrock classification", { dep });
          } else {
            const classification = await classifyChangelog({
              dep,
              fromVersion,
              toVersion,
              rawChangelog: section,
            });
            breakingChanges = classification.breakingChanges;
            if (classification.changelogUrls.length > 0) {
              changelogUrls = [...new Set([...changelogUrls, ...classification.changelogUrls])];
            }

            // Cache the result
            await putChangelogCache({
              dep,
              version: toVersion,
              fetchedAt: new Date().toISOString(),
              sourceUrl: usedUrl,
              rawContent: section.slice(0, 50_000), // cap storage
              breakingChanges,
            });
          }
        }

        await updateUpgradeStatus(teamId, upgradeId, "analyzed", {
          changelogUrls,
          breakingChanges,
        });
      }

      // ── Step 3: Scan codebase for usage sites ────────────────────────────
      let patchedFiles: PatchedFile[] = [];
      let humanReviewItems: HumanReviewItem[] = [];

      if (breakingChanges.length > 0) {
        const { token } = await getInstallationToken(repoConfig.installationId);
        const usageSites = await scanUsageSites(
          repoConfig.owner,
          repoConfig.repo,
          dep,
          breakingChanges,
          token,
        );

        // ── Step 4: Synthesize migration patches ─────────────────────────
        if (usageSites.length > 0) {
          const synthesis = await synthesizeMigration({
            dep,
            fromVersion,
            toVersion,
            breakingChanges,
            usageSites,
          });

          patchedFiles = synthesis.patches
            .filter((p) => p.confidence !== "low")
            .map((p) => ({
              filePath: p.filePath,
              lineStart: p.lineStart,
              lineEnd: p.lineEnd,
              originalCode: p.originalCode,
              patchedCode: p.patchedCode,
              breakingChangeDescription: p.breakingChangeDescription,
            }));

          humanReviewItems = [
            ...synthesis.humanReviewItems,
            // Low-confidence patches become human review items
            ...synthesis.patches
              .filter((p) => p.confidence === "low")
              .map((p) => ({
                filePath: p.filePath,
                line: p.lineStart,
                reason: `Low-confidence patch for: ${p.breakingChangeDescription}`,
                suggestion: `Replace \`${p.originalCode}\` with \`${p.patchedCode}\``,
              })),
          ];
        } else {
          log("info", "No usage sites found — no patches to apply", { dep });
        }

        await updateUpgradeStatus(teamId, upgradeId, "patched", { patchedFiles, humanReviewItems });
      }

      // ── Step 5: Open GitHub PR ────────────────────────────────────────────
      const { token } = await getInstallationToken(repoConfig.installationId);
      void token; // already used above; re-fetch for PR creation
      const pr = await createUpgradePR({
        installationId: repoConfig.installationId,
        owner: repoConfig.owner,
        repo: repoConfig.repo,
        dep,
        fromVersion,
        toVersion,
        changelogUrls,
        breakingChanges,
        patchedFiles,
        humanReviewItems,
        defaultBranch: repoConfig.defaultBranch,
      });

      // Awaited audit write
      await updateUpgradeStatus(teamId, upgradeId, "pr-opened", {
        prNumber: pr.number,
        prUrl: pr.url,
      });

      log("info", "Upgrade pipeline complete", {
        teamId,
        dep,
        toVersion,
        prUrl: pr.url,
        breakingChangesCount: breakingChanges.length,
        patchedFilesCount: patchedFiles.length,
        humanReviewItemsCount: humanReviewItems.length,
      });

      return {
        ...record,
        status: "pr-opened",
        prNumber: pr.number,
        prUrl: pr.url,
        changelogUrls,
        breakingChanges,
        patchedFiles,
        humanReviewItems,
        updatedAt: new Date().toISOString(),
      };
    });
  } catch (err) {
    const errorMessage = String(err);
    log("error", "Upgrade pipeline failed", { teamId, dep, toVersion, error: errorMessage });
    // Awaited audit write — failure must be recorded
    await updateUpgradeStatus(teamId, upgradeId, "failed", { errorMessage });
    return { ...record, status: "failed", errorMessage, updatedAt: new Date().toISOString() };
  }
}
