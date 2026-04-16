/**
 * Kiln Upgrade Worker Lambda
 *
 * SQS consumer — one message per UpgradeJob.
 * Orchestration pipeline:
 *   1. Fetch team config + validate job
 *   2. Acquire GitHub installation token
 *   3. Fetch changelog (domain-allowlisted, DynamoDB-cached)
 *   4. Classify changelog for breaking changes (Bedrock Haiku)
 *   5. Extract breaking changes (Bedrock Sonnet)
 *   6. For each watched repo: find usage sites via GitHub code search
 *   7. For each usage site: synthesize patch (Bedrock Sonnet/Opus)
 *   8. Create Kiln branch, apply patches, open PR
 *   9. Record PR ledger entry + audit log (both awaited)
 *  10. Slack notification (best-effort; failures do not abort the job)
 */
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { docClient, TABLE_NAMES } from '../shared/dynamo';
import { writeAuditEvent } from '../shared/audit';
import { consumeTokens, RateLimitExceeded } from '../shared/rate-limiter';
import {
  getInstallationToken,
  getDefaultBranchSha,
  createKilnBranch,
  searchCode,
  getFileContent,
} from '../shared/github-app';
import { fetchChangelog } from './changelog';
import { analyzeChangelog, analyzeAndSynthesize } from './analyzer';
import { resolveGroupKey, buildBranchName } from './grouper';
import { patchAndCommit } from './patcher';
import { openKilnPr, collectAllChangelogUrls } from './pr-author';
import type {
  UpgradeJob,
  TeamConfig,
  PrLedgerEntry,
  MigrationResult,
  CodeUsage,
  BreakingChange,
} from '../shared/types';

const WORKER_IDENTITY = 'system:upgrade-worker';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getTeamConfig(teamId: string): Promise<TeamConfig | null> {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAMES.TEAM_CONFIG,
    Key: { teamId },
    ConsistentRead: true,
  }));
  return result.Item ? (result.Item as TeamConfig) : null;
}

async function writePrLedgerEntry(entry: PrLedgerEntry): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: TABLE_NAMES.PR_LEDGER,
    Item: entry,
  }));
}

async function updatePrLedgerStatus(
  teamId: string,
  prId: string,
  status: PrLedgerEntry['status'],
  extra: Partial<PrLedgerEntry> = {},
): Promise<void> {
  const now = new Date().toISOString();
  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAMES.PR_LEDGER,
    Key: { teamId, prId },
    UpdateExpression: 'SET #s = :s, updatedAt = :now' +
      (extra.githubPrNumber !== undefined ? ', githubPrNumber = :prNum' : '') +
      (extra.githubPrUrl !== undefined ? ', githubPrUrl = :prUrl' : ''),
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':s': status,
      ':now': now,
      ...(extra.githubPrNumber !== undefined ? { ':prNum': extra.githubPrNumber } : {}),
      ...(extra.githubPrUrl !== undefined ? { ':prUrl': extra.githubPrUrl } : {}),
    },
  }));
}

/**
 * Search for usages of an API surface in a repo.
 * Returns CodeUsage objects with file paths, line numbers, and excerpts.
 */
async function findUsages(params: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  change: BreakingChange;
}): Promise<CodeUsage[]> {
  if (!params.change.apiSurface) return [];

  const searchQuery = `${params.change.apiSurface} repo:${params.owner}/${params.repo} language:TypeScript language:JavaScript`;

  let files: Array<{ path: string }>;
  try {
    files = await searchCode({ token: params.token, query: searchQuery });
  } catch (err) {
    console.warn('Code search failed, skipping usage detection:', err);
    return [];
  }

  const usages: CodeUsage[] = [];
  for (const file of files.slice(0, 20)) {  // cap at 20 files to avoid unbounded work
    const content = await getFileContent({
      token: params.token,
      owner: params.owner,
      repo: params.repo,
      path: file.path,
      ref: params.ref,
    });
    if (!content) continue;

    const lines = content.content.split('\n');
    const matchingLines: number[] = [];
    const surface = params.change.apiSurface ?? '';

    for (let i = 0; i < lines.length; i++) {
      if (surface && lines[i]!.includes(surface)) {
        matchingLines.push(i + 1);  // 1-based
      }
    }

    if (matchingLines.length === 0) continue;

    // Extract a 3-line context window around each match
    const contextStart = Math.max(0, (matchingLines[0] ?? 1) - 2);
    const contextEnd = Math.min(lines.length - 1, (matchingLines[matchingLines.length - 1] ?? 1));
    const excerpt = lines.slice(contextStart, contextEnd + 1).join('\n');

    usages.push({ file: file.path, lines: matchingLines, excerpt });
  }

  return usages;
}

// ─── Main job processor ───────────────────────────────────────────────────────

async function processUpgradeJob(job: UpgradeJob): Promise<void> {
  const prId = `${job.groupKey}#${job.toVersion}`;
  const now = new Date().toISOString();

  // 1. Fetch team config
  const config = await getTeamConfig(job.teamId);
  if (!config) {
    console.error(`No config for team ${job.teamId} — skipping job ${job.jobId}`);
    return;
  }

  // Create initial ledger entry (pending → in-progress)
  const ledger: PrLedgerEntry = {
    teamId: job.teamId,
    prId,
    groupKey: job.groupKey,
    packageName: job.packageName,
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    repo: job.repo,
    status: 'in-progress',
    migrations: [],
    changelogUrls: [job.changelogUrl],
    createdAt: now,
    updatedAt: now,
  };
  await writePrLedgerEntry(ledger);

  await writeAuditEvent({
    teamId: job.teamId,
    action: 'upgrade.started',
    actorIdentity: WORKER_IDENTITY,
    metadata: { jobId: job.jobId, packageName: job.packageName, toVersion: job.toVersion },
  });

  try {
    // 2. GitHub rate limiter (shared DynamoDB bucket)
    const rateLimitKey = `github-api:${job.githubOrg}`;
    await consumeTokens(rateLimitKey, 10);   // reserve tokens for this job

    // 3. Fetch installation token
    const installationId = parseInt(process.env.KILN_GITHUB_INSTALLATION_ID ?? '0', 10);
    if (!installationId) throw new Error('KILN_GITHUB_INSTALLATION_ID not set');
    const installation = await getInstallationToken(installationId);

    await writeAuditEvent({
      teamId: job.teamId,
      action: 'changelog.fetched',
      actorIdentity: WORKER_IDENTITY,
      metadata: { packageName: job.packageName, changelogUrl: job.changelogUrl },
    });

    // 4. Fetch and cache changelog
    const changelogContent = await fetchChangelog(
      job.packageName,
      job.toVersion,
      job.changelogUrl,
    );

    // 5. Analyze changelog for breaking changes
    const classification = await analyzeChangelog({
      packageName: job.packageName,
      fromVersion: job.fromVersion,
      toVersion: job.toVersion,
      changelogContent,
      changelogUrl: job.changelogUrl,
      codeUsages: new Map(),  // populated below
    });

    const allMigrations: MigrationResult[] = [];

    if (classification.hasBreakingChanges) {
      const repos = config.watchedRepos.filter(
        (r) => !(config.pinnedSkipRepos ?? []).includes(r),
      );

      for (const repo of repos) {
        const { branch: defaultBranch, sha: defaultSha } =
          await getDefaultBranchSha({ token: installation.token, owner: job.githubOrg, repo });

        // 6. Find usage sites for each breaking change
        const usagesByChange = new Map<BreakingChange, CodeUsage[]>();
        for (const change of classification.breakingChanges) {
          const usages = await findUsages({
            token: installation.token,
            owner: job.githubOrg,
            repo,
            ref: defaultBranch,
            change,
          });
          usagesByChange.set(change, usages);
        }

        // 7. Synthesize patches
        const repoMigrations: MigrationResult[] = [];
        for (const [change, usages] of usagesByChange) {
          const results = await analyzeAndSynthesize(change, usages);
          repoMigrations.push(...results);
        }

        allMigrations.push(...repoMigrations);

        // 8. Create Kiln branch and apply patches
        const branchName = buildBranchName(job.groupKey, job.toVersion);
        await createKilnBranch({
          token: installation.token,
          owner: job.githubOrg,
          repo,
          branchName,
          fromSha: defaultSha,
        });

        // Apply only 'patched' migrations
        const patches = repoMigrations
          .filter((m): m is Extract<MigrationResult, { kind: 'patched' }> => m.kind === 'patched')
          .flatMap((m) => m.patches);

        if (patches.length > 0) {
          await patchAndCommit({
            token: installation.token,
            owner: job.githubOrg,
            repo,
            branch: branchName,
            patches,
            commitMessagePrefix: `chore(deps): upgrade ${job.packageName} to ${job.toVersion}`,
          });
        }

        // 9. Open PR
        const changelogUrls = collectAllChangelogUrls(repoMigrations);
        if (changelogUrls.length === 0) changelogUrls.push(job.changelogUrl);

        const pr = await openKilnPr({
          token: installation.token,
          owner: job.githubOrg,
          repo,
          head: branchName,
          base: defaultBranch,
          packageName: job.packageName,
          fromVersion: job.fromVersion,
          toVersion: job.toVersion,
          changelogUrls,
          migrations: repoMigrations,
        });

        // 10. Update ledger with PR details
        await updatePrLedgerStatus(job.teamId, prId, 'opened', {
          githubPrNumber: pr.number,
          githubPrUrl: pr.url,
        });

        await writeAuditEvent({
          teamId: job.teamId,
          action: 'pr.opened',
          actorIdentity: WORKER_IDENTITY,
          metadata: {
            jobId: job.jobId,
            repo,
            prNumber: pr.number,
            prUrl: pr.url,
            packageName: job.packageName,
            toVersion: job.toVersion,
            migrationsCount: repoMigrations.length,
          },
        });
      }
    } else {
      // No breaking changes — open a simple version bump PR
      for (const repo of config.watchedRepos) {
        const { branch: defaultBranch, sha: defaultSha } =
          await getDefaultBranchSha({ token: installation.token, owner: job.githubOrg, repo });

        const branchName = buildBranchName(job.groupKey, job.toVersion);
        await createKilnBranch({
          token: installation.token,
          owner: job.githubOrg,
          repo,
          branchName,
          fromSha: defaultSha,
        });

        const pr = await openKilnPr({
          token: installation.token,
          owner: job.githubOrg,
          repo,
          head: branchName,
          base: defaultBranch,
          packageName: job.packageName,
          fromVersion: job.fromVersion,
          toVersion: job.toVersion,
          changelogUrls: [job.changelogUrl],
          migrations: [],
        });

        await updatePrLedgerStatus(job.teamId, prId, 'opened', {
          githubPrNumber: pr.number,
          githubPrUrl: pr.url,
        });

        await writeAuditEvent({
          teamId: job.teamId,
          action: 'pr.opened',
          actorIdentity: WORKER_IDENTITY,
          metadata: { jobId: job.jobId, repo, prNumber: pr.number, prUrl: pr.url },
        });
      }
    }

    // Final ledger update with all migration results
    const finalEntry: PrLedgerEntry = {
      ...ledger,
      status: 'opened',
      migrations: allMigrations,
      changelogUrls: [job.changelogUrl],
      updatedAt: new Date().toISOString(),
    };
    await writePrLedgerEntry(finalEntry);

    await writeAuditEvent({
      teamId: job.teamId,
      action: 'upgrade.completed',
      actorIdentity: WORKER_IDENTITY,
      metadata: { jobId: job.jobId, packageName: job.packageName, toVersion: job.toVersion },
    });

  } catch (err) {
    console.error(`Upgrade job ${job.jobId} failed:`, err);
    await updatePrLedgerStatus(job.teamId, prId, 'failed');
    await writeAuditEvent({
      teamId: job.teamId,
      action: 'upgrade.failed',
      actorIdentity: WORKER_IDENTITY,
      metadata: {
        jobId: job.jobId,
        error: err instanceof Error ? err.message : String(err),
        packageName: job.packageName,
        toVersion: job.toVersion,
      },
    });
    throw err;  // Re-throw so SQS routes to DLQ after maxReceiveCount
  }
}

// ─── SQS event handler ────────────────────────────────────────────────────────

export const handler = async (event: SQSEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
  const failures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      const job = JSON.parse(record.body) as UpgradeJob;
      await processUpgradeJob(job);
    } catch (err) {
      // Return partial batch failure so SQS only retries the failed messages
      console.error(`Failed to process SQS record ${record.messageId}:`, err);

      if (err instanceof RateLimitExceeded) {
        // Poison the whole batch on rate limit — let SQS backoff handle retry
        return { batchItemFailures: event.Records.map((r: SQSRecord) => ({ itemIdentifier: r.messageId })) };
      }

      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
