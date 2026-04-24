import "dotenv/config";
import { readFileSync } from "node:fs";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { Pool } from "pg";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./logger.js";
import { initTelemetry } from "./otel/bootstrap.js";
import { createDdbClientsRepo } from "./clients/ddb.js";
import { createSqsAuditLogger } from "./audit/sqs.js";
import { createDdbMemoStorage } from "./memo/storage.js";
import { createDdbDedup } from "./crawlers/dedup.js";
import { createHttpFetcher } from "./crawlers/http.js";
import { createDefaultCrawlers } from "./crawlers/sources.js";
import { createCrawlerRegistry } from "./crawlers/registry.js";
import { createBedrockEmbedder } from "./pipeline/embed-bedrock.js";
import { createPgVectorStore, ensureCorpusSchema } from "./pipeline/pgvector.js";
import { createCorpusIndexer } from "./pipeline/indexer.js";
import { createBedrockLlm } from "./classifier/bedrock.js";
import { createClassifier } from "./classifier/classifier.js";
import { createMemoDrafter } from "./memo/drafter.js";
import { createNotionPublisher } from "./publish/notion.js";
import { createApprovalGate } from "./publish/approval-gate.js";
import { createSlackChannel } from "./notify/slack.js";
import { createEmailChannel } from "./notify/email.js";
import { createNotifier } from "./notify/notifier.js";
import { createSqsQueueProvider } from "./consumer/sqs.js";
import { createQueueConsumer } from "./consumer/handler.js";
import { createHealthServer } from "./health/server.js";
import { createCrawlHandler } from "./handlers/crawl.js";
import { createClassifyHandler } from "./handlers/classify.js";
import { createPublishHandler } from "./handlers/publish.js";

// ── Bootstrap ──────────────────────────────────────────────────────
//
// Single wiring file. Builds every SDK client once, hands typed ports
// to each consumer. Stays thin on purpose: every cross-boundary
// factory lives in its own module, this file is just the seams.
//

const config = loadConfig();
const logger = createLogger(config.env.LOG_LEVEL, "watchtower");
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

initTelemetry({
  serviceName: "watchtower",
  serviceVersion: packageJson.version,
  environment: config.env.NODE_ENV,
  region: config.env.AWS_REGION,
});

logger.info("watchtower starting", {
  environment: config.env.NODE_ENV,
  region: config.env.AWS_REGION,
  bedrockRegion: config.bedrockRegion,
  healthPort: config.env.HEALTH_PORT,
});

// ── SDK clients ────────────────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.env.AWS_REGION }));
const sqs = new SQSClient({ region: config.env.AWS_REGION });
const bedrock = new BedrockRuntimeClient({ region: config.bedrockRegion });
const pgPool = new Pool({
  host: config.env.CORPUS_HOST,
  port: config.env.CORPUS_PORT,
  database: config.env.CORPUS_DATABASE,
  user: config.env.CORPUS_USER,
  password: config.env.CORPUS_PASSWORD,
  ssl: config.isProd ? { rejectUnauthorized: true } : undefined,
});

// ── Ports ──────────────────────────────────────────────────────────
const clients = createDdbClientsRepo({
  ddb,
  tableName: config.env.CLIENTS_TABLE,
  logger: logger.child("clients"),
});

const audit = createSqsAuditLogger({
  sqs,
  queueUrl: config.env.AUDIT_QUEUE_URL,
  logger: logger.child("audit"),
});

const memos = createDdbMemoStorage({ ddb, tableName: config.env.MEMOS_TABLE });
const dedup = createDdbDedup({ ddb, tableName: config.env.DEDUP_TABLE });

const fetcher = createHttpFetcher({ logger: logger.child("http") });
const crawlers = createCrawlerRegistry(
  createDefaultCrawlers({ fetcher, logger: logger.child("crawler") }),
);

const embedder = createBedrockEmbedder({
  bedrock,
  modelId: config.env.EMBEDDING_MODEL_ID,
  logger: logger.child("embedder"),
});
const vectorStore = createPgVectorStore({ pool: pgPool });
const indexer = createCorpusIndexer({
  embedder,
  vectorStore,
  logger: logger.child("corpus"),
});

const classifierLlm = createBedrockLlm({
  bedrock,
  modelId: config.env.CLASSIFIER_MODEL_ID,
  logger: logger.child("classifier-llm"),
  defaultTimeoutMs: config.env.BEDROCK_TIMEOUT_MS,
});
const classifier = createClassifier({
  llm: classifierLlm,
  logger: logger.child("classifier"),
  autoAlertThreshold: config.env.APPLICABILITY_AUTO_ALERT_THRESHOLD,
  reviewThreshold: config.env.APPLICABILITY_REVIEW_THRESHOLD,
});

const memoLlm = createBedrockLlm({
  bedrock,
  modelId: config.env.MEMO_MODEL_ID,
  logger: logger.child("memo-llm"),
  defaultTimeoutMs: config.env.BEDROCK_TIMEOUT_MS,
});
const drafter = createMemoDrafter({ llm: memoLlm, logger: logger.child("memo") });

const notionPublisher = config.env.NOTION_OAUTH_CLIENT_SECRET
  ? createNotionPublisher({
      apiToken: config.env.NOTION_OAUTH_CLIENT_SECRET,
      logger: logger.child("publish-notion"),
    })
  : undefined;

const gate = createApprovalGate({
  memos,
  clients,
  publishers: { notion: notionPublisher, confluence: undefined },
  audit,
  logger: logger.child("gate"),
});

const slack = createSlackChannel({ logger: logger.child("slack") });
const email = config.env.RESEND_API_KEY
  ? createEmailChannel({
      apiKey: config.env.RESEND_API_KEY,
      fromAddress: config.env.NOTIFICATION_FROM_EMAIL,
      logger: logger.child("email"),
    })
  : undefined;

async function notifierFor(clientId: string) {
  const client = await clients.get(clientId);
  if (!client) return null;
  return createNotifier({
    slack,
    ...(email ? { email } : {}),
    audit,
    client,
    ...(config.env.SLACK_WEBHOOK_URL
      ? { fallbackSlackWebhookUrl: config.env.SLACK_WEBHOOK_URL }
      : {}),
    logger: logger.child("notifier"),
  });
}

// ── Queue providers (one per stage) ────────────────────────────────
const crawlQueue = createSqsQueueProvider({
  sqs,
  queueUrl: config.env.CRAWL_QUEUE_URL,
  jobName: "crawl",
  logger: logger.child("sqs.crawl"),
});
const classifyQueue = createSqsQueueProvider({
  sqs,
  queueUrl: config.env.CLASSIFY_QUEUE_URL,
  jobName: "classify",
  logger: logger.child("sqs.classify"),
});
const publishQueue = createSqsQueueProvider({
  sqs,
  queueUrl: config.env.PUBLISH_QUEUE_URL,
  jobName: "publish",
  logger: logger.child("sqs.publish"),
});

// ── Consumers ──────────────────────────────────────────────────────
const crawlConsumer = createQueueConsumer(
  crawlQueue,
  {
    crawl: createCrawlHandler({
      crawlers,
      dedup,
      indexer,
      clients,
      classifyQueue,
      audit,
      logger: logger.child("handler.crawl"),
    }),
  },
  logger.child("consumer.crawl"),
  { concurrency: config.env.CRAWL_CONCURRENCY, pollInterval: config.env.CONSUMER_POLL_INTERVAL_MS },
);

const classifyConsumer = createQueueConsumer(
  classifyQueue,
  {
    classify: createClassifyHandler({
      classifier,
      drafter,
      memos,
      notifier: notifierFor,
      publishQueue,
      clients,
      audit,
      logger: logger.child("handler.classify"),
    }),
  },
  logger.child("consumer.classify"),
  {
    concurrency: config.env.CLASSIFY_CONCURRENCY,
    pollInterval: config.env.CONSUMER_POLL_INTERVAL_MS,
  },
);

const publishConsumer = createQueueConsumer(
  publishQueue,
  { publish: createPublishHandler({ gate, logger: logger.child("handler.publish") }) },
  logger.child("consumer.publish"),
  {
    concurrency: config.env.PUBLISH_CONCURRENCY,
    pollInterval: config.env.CONSUMER_POLL_INTERVAL_MS,
  },
);

// ── Health server ──────────────────────────────────────────────────
const health = createHealthServer({
  port: config.env.HEALTH_PORT,
  checks: {
    "consumer-crawl": () => crawlConsumer.polling,
    "consumer-classify": () => classifyConsumer.polling,
    "consumer-publish": () => publishConsumer.polling,
  },
  logger: logger.child("health"),
});

// ── Startup sequence ───────────────────────────────────────────────
async function start(): Promise<void> {
  logger.info("ensuring corpus schema");
  try {
    await ensureCorpusSchema(pgPool, { embeddingDimensions: embedder.dimensions });
  } catch (err) {
    logger.fatal("failed to ensure corpus schema; refusing to start", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
  health.start();
  crawlConsumer.start();
  classifyConsumer.start();
  publishConsumer.start();
  logger.info("watchtower ready");
}

// ── Graceful shutdown ──────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, draining`);
  try {
    await Promise.allSettled([
      crawlConsumer.stop(config.env.SHUTDOWN_TIMEOUT_MS),
      classifyConsumer.stop(config.env.SHUTDOWN_TIMEOUT_MS),
      publishConsumer.stop(config.env.SHUTDOWN_TIMEOUT_MS),
    ]);
    await health.stop();
    await pgPool.end();
  } catch (err) {
    logger.error("shutdown error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

setTimeout(() => {
  logger.fatal("forced shutdown — deadline exceeded");
  process.exit(1);
}, config.env.SHUTDOWN_TIMEOUT_MS + 5000).unref();

start().catch((err) => {
  logger.fatal("startup failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
