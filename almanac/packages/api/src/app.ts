import Fastify from 'fastify';
import { createClient } from 'redis';
import { AlmanacPipeline } from '@almanac/ai';
import { NotionAdapter, ConfluenceAdapter, GoogleDriveAdapter } from '@almanac/connectors';
import { TokenStore } from './services/token-store.js';
import { RateLimiter } from './services/rate-limit.js';
import { AuditLogger } from './services/audit.js';
import { slackRoutes } from './routes/slack.js';
import { oauthRoutes } from './routes/oauth.js';

const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';
const REDIS_URL = process.env.REDIS_URL!;
// BASE_URL injected via ECS secret from almanac/oauth-client-secrets
const BASE_URL = process.env.BASE_URL!;

async function buildApp() {
  const fastify = Fastify({ logger: true, bodyLimit: 1_048_576 });

  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as { rawBody?: string }).rawBody = body as string;
    try { done(null, JSON.parse(body as string)); } catch (err) { done(err as Error); }
  });

  const redis = createClient({ url: REDIS_URL });
  await redis.connect();

  const tokenStore = new TokenStore({ region: AWS_REGION, tableName: process.env.DYNAMO_TOKENS_TABLE!, kmsKeyId: process.env.KMS_KEY_ID! });
  const rateLimiter = new RateLimiter(redis as Parameters<typeof RateLimiter.prototype.constructor>[0]);
  const auditLogger = new AuditLogger({ region: AWS_REGION, queueUrl: process.env.AUDIT_SQS_QUEUE_URL! });

  const connectorAdapters = [
    new NotionAdapter(),
    new ConfluenceAdapter(process.env.CONFLUENCE_BASE_URL!),
    new GoogleDriveAdapter(),
  ];
  const pipeline = new AlmanacPipeline({ region: AWS_REGION, topChunksForGeneration: 5 }, connectorAdapters);

  await fastify.register(slackRoutes, { tokenStore, rateLimiter, auditLogger, pipeline, baseUrl: BASE_URL });
  await fastify.register(oauthRoutes, { redis: redis as Parameters<typeof oauthRoutes>[1]['redis'], tokenStore, baseUrl: BASE_URL });

  fastify.get('/health', async () => ({ status: 'ok', version: process.env.npm_package_version ?? 'unknown' }));
  fastify.get('/metrics', async (_req, reply) => { reply.header('Content-Type', 'text/plain'); return '# Almanac metrics\n'; });

  return fastify;
}

async function main() {
  const app = await buildApp();
  await app.listen({ port: 3000, host: '0.0.0.0' });
  app.log.info('Almanac API listening on :3000');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
