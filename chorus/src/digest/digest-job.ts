import { getDbPool, closeDbPool } from '../lib/db.js';
import { createSlackClient } from '../lib/slack.js';
import { createDirectoryClient } from '../lib/directory.js';
import { logger } from '../lib/observability.js';
import { prewarmSecrets } from '../lib/secrets.js';
import { bootstrapAuditWriter } from '../lib/audit-bootstrap.js';
import { postWeeklyDigest } from './weekly-digest.js';

export const DIGEST_REQUIRED_SECRETS = ['chorus/slack/bot-token', 'chorus/workos/api-key'] as const;

/**
 * One-shot CLI entrypoint for the weekly digest. EventBridge Scheduler
 * invokes this as an ECS RunTask on Mondays 09:00 PT (cron in
 * `infra/lib/chorus-stack.ts`). Exits 0 on success, nonzero on any
 * unhandled failure so the scheduler retries per its policy.
 *
 * Required env:
 *   DIGEST_CHANNEL         e.g. "#product-feedback"
 *   REVIEW_BASE_URL        e.g. "https://chorus.acme.com"
 *   WORKOS_PM_GROUP_ID     WorkOS Directory Sync group ID for PMs
 */
async function main(): Promise<void> {
  const channel = required('DIGEST_CHANNEL');
  const reviewBaseUrl = required('REVIEW_BASE_URL');
  const groupId = required('WORKOS_PM_GROUP_ID');

  if (process.env['SKIP_SECRETS_PREWARM'] !== 'true') {
    await prewarmSecrets([...DIGEST_REQUIRED_SECRETS]);
    logger.info('secrets prewarm ok', { count: DIGEST_REQUIRED_SECRETS.length });
  }
  bootstrapAuditWriter();

  const db = getDbPool();
  const slack = createSlackClient();
  const directory = createDirectoryClient();

  const result = await postWeeklyDigest({
    db,
    slack,
    channel,
    reviewBaseUrl,
    listPms: () => directory.listUsers({ groupId }),
  });

  logger.info('weekly digest complete', result);
  await closeDbPool();
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

main().catch((err: unknown) => {
  logger.error('weekly digest failed', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
