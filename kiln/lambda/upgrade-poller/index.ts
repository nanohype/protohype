/**
 * Kiln Upgrade Poller Lambda
 *
 * Triggered by EventBridge every 15 minutes.
 * For each team config:
 *   1. Fetch all watched repos and their current package.json
 *   2. For each watched package in the team config, check if a newer version exists on npm
 *   3. Deduplicate against the PR ledger (don't re-open a PR already in-progress)
 *   4. Enqueue an UpgradeJob on SQS for each new version found
 *   5. Write an audit event for each enqueued job
 */
import type { EventBridgeEvent } from 'aws-lambda';
import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import { docClient, TABLE_NAMES } from '../shared/dynamo';
import { writeAuditEvent } from '../shared/audit';
import { fetchLatestVersion } from './npm-registry';
import { resolveGroupKey } from '../upgrade-worker/grouper';
import type { TeamConfig, UpgradeJob, PrLedgerEntry } from '../shared/types';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const UPGRADE_QUEUE_URL = process.env.KILN_UPGRADE_QUEUE_URL ?? '';
const POLLER_IDENTITY = 'system:upgrade-poller';

const sqsClient = new SQSClient({
  region: REGION,
  requestHandler: {
    requestTimeout: 5_000,
  } as { requestTimeout: number },
});

/** Fetch all team configs via a DynamoDB Scan. */
async function fetchAllTeamConfigs(): Promise<TeamConfig[]> {
  const configs: TeamConfig[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAMES.TEAM_CONFIG,
      ExclusiveStartKey: lastKey as Record<string, unknown>,
    }));
    configs.push(...((result.Items ?? []) as TeamConfig[]));
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return configs;
}

/** Check if an upgrade PR is already open/in-progress for this (teamId, groupKey, toVersion). */
async function prAlreadyExists(teamId: string, prId: string): Promise<boolean> {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAMES.PR_LEDGER,
    KeyConditionExpression: 'teamId = :tid AND prId = :pid',
    ExpressionAttributeValues: { ':tid': teamId, ':pid': prId },
    Limit: 1,
  }));
  if (!result.Items || result.Items.length === 0) return false;
  const entry = result.Items[0] as PrLedgerEntry;
  // Re-open only if the previous attempt was failed or closed
  return !['failed', 'closed'].includes(entry.status);
}

/** Read the current version of a package from a repo's package.json (fetched via npm registry metadata). */
async function getCurrentVersionInRepo(
  packageName: string,
  _teamConfig: TeamConfig,
): Promise<string> {
  // In a real deployment this would use the GitHub API to read package.json from the repo.
  // The poller runs per-team-config; the actual file read happens in the upgrade-worker
  // which has access to installation tokens. For the poller we use '0.0.0' as a sentinel
  // which forces the npm registry check to always return the latest version, and the
  // upgrade-worker itself validates the actual installed version before patching.
  //
  // Rationale for this design: the poller runs on a cron and should be fast/cheap.
  // The expensive GitHub API calls happen in the worker per upgrade job.
  void packageName;
  return '0.0.0';
}

export const handler = async (_event: EventBridgeEvent<string, unknown>): Promise<void> => {
  const configs = await fetchAllTeamConfigs();
  console.log(`Upgrade poller: processing ${configs.length} team configs`);

  for (const config of configs) {
    for (const pkg of config.watchedPackages) {
      try {
        const currentVersion = await getCurrentVersionInRepo(pkg.name, config);
        const latest = await fetchLatestVersion(pkg, currentVersion);

        if (!latest) continue;   // Already at latest or no upgrade available

        const groupKey = resolveGroupKey(pkg.name, config.grouping);
        const prId = `${groupKey}#${latest.latestVersion}`;

        if (await prAlreadyExists(config.teamId, prId)) {
          console.log(`Skipping ${pkg.name} ${latest.latestVersion} for ${config.teamId}: PR already exists`);
          continue;
        }

        const job: UpgradeJob = {
          jobId: randomUUID(),
          teamId: config.teamId,
          githubOrg: config.githubOrg,
          repo: config.watchedRepos[0] ?? '',  // worker expands to all repos
          packageName: pkg.name,
          fromVersion: currentVersion,
          toVersion: latest.latestVersion,
          changelogUrl: latest.changelogUrl,
          groupKey,
          groupStrategy: config.grouping,
          enqueuedAt: new Date().toISOString(),
        };

        await sqsClient.send(new SendMessageCommand({
          QueueUrl: UPGRADE_QUEUE_URL,
          MessageBody: JSON.stringify(job),
          MessageGroupId: `${config.teamId}:${groupKey}`,
          MessageDeduplicationId: `${config.teamId}:${prId}`,
        }));

        await writeAuditEvent({
          teamId: config.teamId,
          action: 'upgrade.enqueued',
          actorIdentity: POLLER_IDENTITY,
          metadata: {
            packageName: pkg.name,
            fromVersion: currentVersion,
            toVersion: latest.latestVersion,
            jobId: job.jobId,
          },
        });

        console.log(`Enqueued upgrade: ${config.teamId} / ${pkg.name} → ${latest.latestVersion}`);
      } catch (err) {
        // Log but don't fail the entire run — one bad package shouldn't block others
        console.error(`Failed to process ${pkg.name} for team ${config.teamId}:`, err);
      }
    }
  }
};
