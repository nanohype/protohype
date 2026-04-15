import type { Pool } from 'pg';
import { getDbPool, closeDbPool } from '../lib/db.js';
import { getSecretString, prewarmSecrets } from '../lib/secrets.js';
import { bootstrapAuditWriter } from '../lib/audit-bootstrap.js';
import { logger } from '../lib/observability.js';
import { createLinearSync, type LinearSync } from './linear-sync.js';

export const WORKER_REQUIRED_SECRETS = ['chorus/linear/api-key'] as const;

/**
 * The chorus worker process. Drives the Linear backlog mirror on a
 * fixed cadence (LINEAR_MIRROR_INTERVAL_SECONDS, default 1 hour).
 *
 * Two modes:
 *   long-running: spawn interval, listen for SIGINT/SIGTERM, drain
 *                 then exit. This is what runs in ECS / Kubernetes.
 *   one-shot:     `WORKER_ONESHOT=true` — mirror once and exit. This
 *                 is what runs under EventBridge Scheduler.
 *
 * Feedback ingestion is push-based (Slack Events + webhook on the
 * API server), so the worker no longer polls connectors.
 */

interface WorkerConfig {
  linearMirrorIntervalSeconds: number;
  oneshot: boolean;
}

function readConfig(): WorkerConfig {
  return {
    linearMirrorIntervalSeconds: parseSeconds(
      process.env['LINEAR_MIRROR_INTERVAL_SECONDS'],
      60 * 60,
    ),
    oneshot: process.env['WORKER_ONESHOT'] === 'true',
  };
}

function parseSeconds(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface WorkerDeps {
  db: Pool;
  linear: LinearSync;
  config: WorkerConfig;
}

export async function mirrorOnce(deps: WorkerDeps): Promise<void> {
  try {
    await deps.linear.mirror({ db: deps.db });
  } catch (err) {
    logger.error('linear mirror failed', { error: String(err) });
  }
}

export async function runOnce(deps: WorkerDeps): Promise<void> {
  await mirrorOnce(deps);
}

export function buildDefaultDeps(): WorkerDeps {
  const config = readConfig();
  const db = getDbPool();
  const linear = createLinearSync({
    getApiToken: () => getSecretString('chorus/linear/api-key'),
  });
  return { db, linear, config };
}

export async function run(deps: WorkerDeps = buildDefaultDeps()): Promise<void> {
  if (process.env['SKIP_SECRETS_PREWARM'] !== 'true') {
    await prewarmSecrets([...WORKER_REQUIRED_SECRETS]);
    logger.info('secrets prewarm ok', { count: WORKER_REQUIRED_SECRETS.length });
  }
  bootstrapAuditWriter();

  if (deps.config.oneshot) {
    logger.info('worker oneshot start');
    await runOnce(deps);
    await closeDbPool();
    return;
  }

  logger.info('worker long-running start', {
    linearMirrorIntervalSeconds: deps.config.linearMirrorIntervalSeconds,
  });

  void mirrorOnce(deps);

  const mirrorTimer = setInterval(
    () => void mirrorOnce(deps),
    deps.config.linearMirrorIntervalSeconds * 1000,
  );

  await new Promise<void>((resolve) => {
    const shutdown = (sig: string) => {
      logger.info('worker shutdown', { signal: sig });
      clearInterval(mirrorTimer);
      void closeDbPool().then(() => resolve());
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
}

const isCli = import.meta.url === `file://${process.argv[1] ?? ''}`;
if (isCli) {
  run().catch((err: unknown) => {
    logger.error('worker fatal', { error: String(err) });
    process.exit(1);
  });
}
