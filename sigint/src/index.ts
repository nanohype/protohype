import { loadConfig } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import { bootstrapLlm } from "./providers/llm.js";
import { bootstrapEmbeddings } from "./providers/embeddings.js";
import { bootstrapVectorStore } from "./providers/vectors.js";
import { loadSourcesFromFile } from "./crawler/sources.js";
import { crawlAll } from "./crawler/index.js";
import { ingestAndDiff } from "./pipeline/index.js";
import { createIntelEngine } from "./intel/index.js";
import { createAlertEngine, type AlertSink } from "./alerts/index.js";
import { createSlackBot } from "./slack/index.js";
import { createScheduler } from "./scheduler/index.js";

async function main(): Promise<void> {
  logger.info("sigint starting");

  // ─── Config ───
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // ─── Providers ───
  const llm = bootstrapLlm(config);
  const embedder = bootstrapEmbeddings(config);
  const store = bootstrapVectorStore(config);

  // ─── Sources ───
  const sources = loadSourcesFromFile("sources.json");

  // ─── Core crawl+process function ───
  // Mutex prevents overlapping runs from scheduler + slash command racing.
  let crawlInProgress = false;

  async function runCrawl(): Promise<void> {
    if (crawlInProgress) {
      logger.warn("crawl already in progress, skipping");
      return;
    }

    if (sources.length === 0) {
      logger.warn("no sources configured, skipping crawl");
      return;
    }

    crawlInProgress = true;
    try {
      const crawlResult = await crawlAll(sources, {
        timeoutMs: config.crawlTimeoutMs,
        userAgent: config.userAgent,
      });

      if (crawlResult.succeeded.length === 0) {
        logger.warn("all crawls failed, nothing to process");
        return;
      }

      const pipelineResult = await ingestAndDiff(crawlResult.succeeded, embedder, store);
      await alertEngine.processDiffs(pipelineResult.diffs);
    } finally {
      crawlInProgress = false;
    }
  }

  // ─── Intel engine ───
  const intel = createIntelEngine(embedder, store, llm);

  // ─── Slack bot + alert sink ───
  let alertSink: AlertSink = {
    async send(channel: string, _message) {
      logger.info("alert (no slack configured)", { channel });
    },
  };

  let slackBot: Awaited<ReturnType<typeof createSlackBot>> | null = null;

  if (config.slackBotToken) {
    slackBot = createSlackBot(config, intel, runCrawl);
    alertSink = slackBot.sink;
  }

  const alertEngine = createAlertEngine(llm, alertSink, config);

  // ─── Scheduler ───
  const scheduler = createScheduler([
    {
      name: "crawl",
      intervalMs: config.crawlIntervalMinutes * 60 * 1000,
      fn: runCrawl,
    },
  ]);

  // ─── Start ───
  scheduler.start();

  if (slackBot) {
    await slackBot.start();
  }

  // Run initial crawl
  logger.info("running initial crawl");
  await runCrawl();

  logger.info("sigint running", {
    sources: sources.length,
    crawlInterval: `${config.crawlIntervalMinutes}m`,
    vectorProvider: config.vectorProvider,
    llmProvider: config.llmProvider,
    slackEnabled: !!config.slackBotToken,
  });

  // ─── Graceful shutdown ───
  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    scheduler.stop();
    if (slackBot) await slackBot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
