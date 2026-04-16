import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { getTeamConfig } from './config-store.js';
import { groupDependencies } from './grouping.js';
import { analyzeChangelog } from './change-analyzer.js';
import { fetchChangelog } from './changelog-fetcher.js';
import { writeAuditEvent } from './audit-logger.js';
import type { DepVersion, MigrationNote, UpgradeGroup } from './types.js';

export interface PipelineContext {
  teamId: string;
  repoFullName: string;
  /** Okta-resolved identity — never constructed from raw IDs. */
  actor: string;
  dynamo: DynamoDBDocumentClient;
  bedrock: BedrockRuntimeClient;
}

export interface PipelineResult {
  groups: UpgradeGroup[];
  /** Keyed by dependency name. */
  migrationNotes: Map<string, MigrationNote>;
  /** Names of deps that were skipped due to pinnedSkipList. */
  skipped: string[];
  errors: Array<{ dependency: string; message: string }>;
}

/**
 * Core upgrade pipeline — orchestrates config lookup, grouping,
 * changelog fetch, Bedrock analysis, and audit writes.
 *
 * Stages:
 * 1. Load team config (audit: CONFIG_READ)
 * 2. Filter pinned/skipped deps
 * 3. Group remaining deps per team strategy
 * 4. For each dep: fetch changelog → Bedrock analysis → build MigrationNote
 * 5. Audit: UPGRADE_TRIGGERED
 *
 * All audit writes are awaited (never fire-and-forget).
 */
export async function runUpgradePipeline(
  deps: DepVersion[],
  ctx: PipelineContext,
): Promise<PipelineResult> {
  const config = await getTeamConfig(ctx.teamId, ctx.dynamo);
  if (!config) {
    throw new Error(`No Kiln config found for team: ${ctx.teamId}`);
  }

  // Audit: config read — blocking
  await writeAuditEvent(
    'CONFIG_READ',
    ctx.teamId,
    ctx.actor,
    { repoFullName: ctx.repoFullName },
    ctx.dynamo,
  );

  const skipped = deps
    .filter((d) => config.pinnedSkipList.includes(d.name))
    .map((d) => d.name);

  const filtered = deps.filter((d) => !config.pinnedSkipList.includes(d.name));

  const groups = groupDependencies(
    filtered,
    ctx.teamId,
    ctx.repoFullName,
    config,
  );

  const migrationNotes = new Map<string, MigrationNote>();
  const errors: Array<{ dependency: string; message: string }> = [];

  for (const dep of filtered) {
    if (!dep.changelogUrl) {
      // No changelog URL — emit a note flagged for human review
      migrationNotes.set(dep.name, {
        dependency: dep.name,
        fromVersion: dep.currentVersion,
        toVersion: dep.latestVersion,
        changelogUrl: '',
        breakingChanges: [
          {
            description: 'No changelog URL available — manual review required',
            requiresHumanReview: true,
          },
        ],
        patches: [],
        humanReviewRequired: true,
      });
      continue;
    }

    let changelog: string;
    try {
      changelog = await fetchChangelog(dep.changelogUrl);
      await writeAuditEvent(
        'CHANGELOG_FETCHED',
        ctx.teamId,
        ctx.actor,
        { dependency: dep.name, url: dep.changelogUrl },
        ctx.dynamo,
      );
    } catch (err) {
      const message = (err as Error).message;
      errors.push({ dependency: dep.name, message });
      migrationNotes.set(dep.name, {
        dependency: dep.name,
        fromVersion: dep.currentVersion,
        toVersion: dep.latestVersion,
        changelogUrl: dep.changelogUrl,
        breakingChanges: [
          {
            description: `Changelog fetch failed: ${message}`,
            requiresHumanReview: true,
          },
        ],
        patches: [],
        humanReviewRequired: true,
      });
      continue;
    }

    const analysis = await analyzeChangelog(
      changelog,
      dep.name,
      dep.currentVersion,
      dep.latestVersion,
      ctx.bedrock,
    );

    const humanReviewRequired = analysis.breakingChanges.some(
      (c) => c.requiresHumanReview,
    );

    migrationNotes.set(dep.name, {
      dependency: dep.name,
      fromVersion: dep.currentVersion,
      toVersion: dep.latestVersion,
      changelogUrl: dep.changelogUrl,
      breakingChanges: analysis.breakingChanges.map((c) => ({
        description: c.description,
        requiresHumanReview: c.requiresHumanReview,
      })),
      patches: [],
      humanReviewRequired,
    });

    if (humanReviewRequired) {
      await writeAuditEvent(
        'BREAKING_CHANGE_FLAGGED',
        ctx.teamId,
        ctx.actor,
        {
          dependency: dep.name,
          fromVersion: dep.currentVersion,
          toVersion: dep.latestVersion,
        },
        ctx.dynamo,
      );
    }
  }

  // Final audit event for the whole upgrade batch — blocking
  await writeAuditEvent(
    'UPGRADE_TRIGGERED',
    ctx.teamId,
    ctx.actor,
    {
      repoFullName: ctx.repoFullName,
      depCount: filtered.length,
      groupCount: groups.length,
      skippedCount: skipped.length,
    },
    ctx.dynamo,
  );

  return { groups, migrationNotes, skipped, errors };
}
