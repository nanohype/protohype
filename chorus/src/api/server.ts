import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { awsRegion, AWS_MAX_ATTEMPTS } from '../lib/aws.js';
import { correlationMiddleware, logger } from '../lib/observability.js';
import { getDbPool } from '../lib/db.js';
import { getSecretString, prewarmSecrets } from '../lib/secrets.js';
import { bootstrapAuditWriter } from '../lib/audit-bootstrap.js';
import { getDlqClient } from '../lib/queue.js';
import { generateDraftTitle } from '../matching/title-generator.js';
import { createProposalsRepository, type ProposalsRepository } from './proposals-repository.js';
import { createLinearSync, type LinearSync } from '../ingestion/linear-sync.js';
import { type PipelineDeps } from '../ingestion/pipeline.js';
import { createProposalsRouter } from './proposals-routes.js';
import { createIngestRouter } from './ingest-routes.js';

export interface ServerDeps {
  port?: number;
  corsAllowedOrigins?: string[];
  repo?: ProposalsRepository;
  linear?: LinearSync;
  pipelineDeps?: PipelineDeps;
}

/**
 * Compose the chorus API:
 *   helmet → CORS → correlation middleware → JSON parser → /healthz
 *   → /slack/events → /api/ingest → /api/proposals/* → 404 → error
 *
 * The DB pool, Linear token, and WorkOS config are all resolved
 * lazily on first request through the modules they live in
 * (db.ts singleton, secrets.ts cache, auth.ts lazy config).
 */
export function createApp(deps: ServerDeps = {}): Application {
  const app = express();
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors(
      corsOptions(deps.corsAllowedOrigins ?? parseOriginList(process.env['CORS_ALLOWED_ORIGINS'])),
    ),
  );

  app.use(express.json({ limit: '256kb' }));
  app.use(correlationMiddleware);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const repo = deps.repo ?? createProposalsRepository(getDbPool());
  const linear =
    deps.linear ??
    createLinearSync({
      getApiToken: () => getSecretString('chorus/linear/api-key'),
    });

  const pipelineDeps = deps.pipelineDeps ?? buildPipelineDeps(getDbPool());

  app.use(createIngestRouter({ pipelineDeps }));
  app.use('/api/proposals', createProposalsRouter({ repo, linear }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled error', {
      method: req.method,
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function buildPipelineDeps(db: ReturnType<typeof getDbPool>): PipelineDeps {
  const bedrock = new BedrockRuntimeClient({
    region: awsRegion(),
    maxAttempts: AWS_MAX_ATTEMPTS,
  });
  return {
    db,
    matcherDeps: { db, bedrockClient: bedrock, generateDraftTitle },
    dlq: getDlqClient(),
  };
}

function corsOptions(allowed: string[]): cors.CorsOptions {
  const set = new Set(allowed);
  return {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (set.has(origin)) return cb(null, true);
      return cb(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Chorus-Correlation-Id'],
    maxAge: 600,
  };
}

function parseOriginList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Secrets the API needs on the request path. Pre-fetched at startup so
 * the first request after boot doesn't hang on Secrets Manager and so
 * a misconfigured deploy fails fast rather than silently.
 */
export const API_REQUIRED_SECRETS = [
  'chorus/slack/signing-secret',
  'chorus/ingest/api-key',
  'chorus/linear/api-key',
] as const;

export async function startServer(deps: ServerDeps = {}): Promise<void> {
  const port = deps.port ?? Number.parseInt(process.env['PORT'] ?? '3000', 10);
  if (process.env['SKIP_SECRETS_PREWARM'] !== 'true') {
    await prewarmSecrets([...API_REQUIRED_SECRETS]);
    logger.info('secrets prewarm ok', { count: API_REQUIRED_SECRETS.length });
  }
  bootstrapAuditWriter();
  const app = createApp(deps);
  app.listen(port, () => {
    logger.info('chorus API listening', { port });
  });
}

const isCli = import.meta.url === `file://${process.argv[1] ?? ''}`;
if (isCli) {
  startServer().catch((err: unknown) => {
    logger.error('startServer failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
