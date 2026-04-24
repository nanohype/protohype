/**
 * palisade — single wiring file.
 *
 * The ONLY place real SDK clients are constructed. Every downstream service
 * runs against port interfaces, so a client fork swaps pgvector → Pinecone,
 * Bedrock → Azure, Redis → Valkey, OTel → Datadog here and nowhere else.
 *
 * The code flow top-to-bottom is:
 *   1. Load + validate config (Zod; fail-fast on invalid env).
 *   2. Boot OTel SDK + build metrics/tracer facades.
 *   3. Build real or fake adapters per port depending on PALISADE_USE_FAKES.
 *   4. Compose the detection pipeline (heuristics → classifier → corpus).
 *   5. Build the label-approval gate (THE critical module).
 *   6. Build the honeypot handler.
 *   7. Create the Hono app with all routes wired.
 *   8. Start the HTTP server. SIGTERM/SIGINT gracefully drains.
 */

import { serve } from "@hono/node-server";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Redis as IORedis } from "ioredis";
import { Pool } from "pg";

import { loadConfig } from "./config/index.js";
import { createLogger } from "./logger.js";
import { initTelemetry } from "./otel/bootstrap.js";
import { createOtelFacade } from "./otel/facade.js";

import { createDdbAuditLog } from "./audit/audit-log.js";
import { createDdbLabelQueue } from "./audit/label-queue.js";
import { createMemoryAuditLog } from "./audit/memory-audit-log.js";
import { createMemoryLabelQueue } from "./audit/memory-label-queue.js";

import { createHeuristicsLayer } from "./detect/heuristics/index.js";
import { createClassifierLayer } from "./detect/classifier/index.js";
import { createBedrockClassifier } from "./detect/classifier/bedrock-classifier.js";
import { createFakeClassifier } from "./detect/classifier/fake.js";
import { createCorpusMatchLayer } from "./detect/corpus-match/index.js";
import { createBedrockEmbedder } from "./detect/corpus-match/bedrock-embedder.js";
import { createFakeEmbedder } from "./detect/corpus-match/fake-embedder.js";
import { createDetectionPipeline } from "./detect/pipeline.js";

import { createPgvectorCorpus } from "./corpus/pgvector-corpus.js";
import { createMemoryCorpus } from "./corpus/memory-corpus.js";

import { createLabelApprovalGate } from "./gate/label-approval-gate.js";
import { createHoneypotHandler } from "./honeypot/handler.js";

import { createRedisLimiter } from "./ratelimit/redis-limiter.js";
import { createMemoryLimiter } from "./ratelimit/memory-limiter.js";
import { createRedisCache } from "./cache/redis-cache.js";
import { createMemoryCache } from "./cache/memory-cache.js";
import { createSqsAttackSink } from "./queue/sqs-sink.js";
import { createSqsHoneypotSink, createMemorySinks } from "./queue/honeypot-sink.js";

import { createFetchUpstream } from "./proxy/upstream.js";
import { createApp } from "./proxy/app.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const telemetry = initTelemetry({
    serviceName: config.OTEL_SERVICE_NAME,
    environment: config.NODE_ENV,
    ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
  });
  const { tracer, metrics } = createOtelFacade(config.OTEL_SERVICE_NAME);

  // ── Adapters: real vs fake (single switch) ─────────────────────────
  const useFakes = config.PALISADE_USE_FAKES;

  // AWS clients — short, explicit timeouts.
  const awsRequestHandler = new NodeHttpHandler({ connectionTimeout: 2_000, requestTimeout: 8_000 });
  const bedrockClient = useFakes ? null : new BedrockRuntimeClient({ region: config.BEDROCK_REGION, requestHandler: awsRequestHandler });
  const ddbClient = useFakes ? null : new DynamoDBClient({ region: config.region, requestHandler: awsRequestHandler });
  const docClient = ddbClient ? DynamoDBDocumentClient.from(ddbClient) : null;
  const sqsClient = useFakes ? null : new SQSClient({ region: config.region, requestHandler: awsRequestHandler });
  const _s3Client = useFakes ? null : new S3Client({ region: config.region, requestHandler: awsRequestHandler });

  // Redis client.
  const redis = useFakes
    ? null
    : new IORedis(config.REDIS_URL, { connectTimeout: 2_000, commandTimeout: 2_000, maxRetriesPerRequest: 1, lazyConnect: true });
  if (redis) await redis.connect().catch(() => logger.warn("Redis initial connect failed; limiter will fail-open"));

  // Postgres pool.
  const pgPool = useFakes
    ? null
    : new Pool({ connectionString: config.PG_URL, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 2_000 });

  // Audit + label queue
  const audit = docClient ? createDdbAuditLog({ docClient, tableName: config.DDB_TABLE_AUDIT, logger }) : createMemoryAuditLog();
  const labelQueue = docClient ? createDdbLabelQueue({ docClient, tableName: config.DDB_TABLE_LABEL_QUEUE }) : createMemoryLabelQueue();

  // Corpus (read + write)
  const corpus = pgPool
    ? createPgvectorCorpus({ pool: pgPool })
    : ((): ReturnType<typeof createPgvectorCorpus> => {
        const mem = createMemoryCorpus();
        return { read: mem.read, write: mem.write };
      })();

  // Embedder + classifier
  const embedder = bedrockClient
    ? createBedrockEmbedder({ client: bedrockClient, modelId: config.BEDROCK_EMBEDDING_MODEL_ID })
    : createFakeEmbedder(1024);
  const classifier = bedrockClient
    ? createBedrockClassifier({ client: bedrockClient, modelId: config.BEDROCK_CLASSIFIER_MODEL_ID })
    : createFakeClassifier();

  // Detection layers
  const heuristics = createHeuristicsLayer({
    base64MinBytes: config.HEURISTICS_BASE64_MIN_BYTES,
    blockThreshold: 0.9,
    allowThreshold: 0.3,
  });
  const classifierLayer = createClassifierLayer(classifier, {
    blockThreshold: config.CLASSIFIER_BLOCK_THRESHOLD,
    allowThreshold: config.CLASSIFIER_ALLOW_THRESHOLD,
  });
  const corpusMatchLayer = createCorpusMatchLayer(embedder, corpus.read, {
    threshold: config.CORPUS_MATCH_THRESHOLD,
    topK: config.CORPUS_MATCH_TOP_K,
  });
  const pipeline = createDetectionPipeline({
    heuristics,
    classifier: classifierLayer,
    corpusMatch: corpusMatchLayer,
    timeouts: {
      heuristicsMs: config.HEURISTICS_TIMEOUT_MS,
      classifierMs: config.CLASSIFIER_TIMEOUT_MS,
      corpusMatchMs: config.CORPUS_MATCH_TIMEOUT_MS,
    },
    metrics,
    tracer,
    logger,
  });

  // THE GATE — the only place that holds `corpus.write`.
  const gate = createLabelApprovalGate({
    audit,
    corpusWriter: corpus.write,
    labelQueue,
    embedder,
    metrics,
    logger,
  });

  // Honeypot
  const sinks = useFakes ? createMemorySinks() : null;
  const attackSink =
    sqsClient && config.SQS_ATTACK_LOG_URL
      ? createSqsAttackSink({
          client: sqsClient,
          queueUrl: config.SQS_ATTACK_LOG_URL,
          ...(config.SQS_ATTACK_LOG_DLQ_URL ? { dlqUrl: config.SQS_ATTACK_LOG_DLQ_URL } : {}),
          metrics,
          logger,
        })
      : sinks!.attack;
  const honeypotSink =
    sqsClient && config.SQS_ATTACK_LOG_URL
      ? createSqsHoneypotSink({ client: sqsClient, queueUrl: config.SQS_ATTACK_LOG_URL, metrics, logger })
      : sinks!.honeypot;
  const honeypot = createHoneypotHandler({
    audit,
    sink: honeypotSink,
    metrics,
    tracer,
    logger,
    latencyJitterMs: { min: 80, max: 260 },
  });

  // Rate limiter + cache
  const rateLimiter = redis
    ? createRedisLimiter({
        redis,
        windowSeconds: 60,
        limitPerWindow: config.RATE_LIMIT_USER_PER_MIN,
        escalationTtlSeconds: config.RATE_LIMIT_ESCALATION_SECONDS,
        metrics,
        logger,
      })
    : createMemoryLimiter({
        windowSeconds: 60,
        limitPerWindow: config.RATE_LIMIT_USER_PER_MIN,
        escalationTtlSeconds: config.RATE_LIMIT_ESCALATION_SECONDS,
      });
  const cache = redis ? createRedisCache(redis) : createMemoryCache();

  // Upstream
  const upstream = createFetchUpstream({
    upstreams: {
      "openai-chat": config.UPSTREAM_OPENAI_URL,
      "anthropic-messages": config.UPSTREAM_ANTHROPIC_URL,
      "bedrock-invoke": config.UPSTREAM_BEDROCK_URL,
    },
    fetchImpl: fetch,
    timeoutMs: 30_000,
  });

  // App
  const app = createApp({
    pipeline,
    upstream,
    rateLimiter,
    audit,
    attackSink,
    cache,
    metrics,
    tracer,
    logger,
    honeypot,
    gate,
    cacheTtlSeconds: 300,
    adminApiKey: config.ADMIN_API_KEY,
    maxBodyBytes: config.MAX_BODY_BYTES,
  });

  // HTTP server with graceful shutdown.
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info({ port: info.port }, "palisade listening");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    server.close();
    await telemetry.shutdown().catch(() => undefined);
    if (redis) await redis.quit().catch(() => undefined);
    if (pgPool) await pgPool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Run when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[palisade] fatal error:", err);
    process.exit(1);
  });
}
