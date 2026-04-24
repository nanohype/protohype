import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import type { AuditPort } from "../audit/types.js";
import type { ClientsPort } from "../clients/types.js";
import type { CrawlerRegistry } from "../crawlers/registry.js";
import type { DedupPort } from "../crawlers/types.js";
import type { CorpusIndexer } from "../pipeline/types.js";
import type { JobHandler } from "../consumer/types.js";
import type { QueueProvider } from "../consumer/types.js";
import { CrawlJob, type ClassifyJob } from "./types.js";

// ── Crawl handler ──────────────────────────────────────────────────
//
// Triggered by an EventBridge Scheduler message on the crawl queue.
// Flow per crawler invocation:
//   1. Fetch the feed and parse RuleChanges.
//   2. For each change, dedup-check. New ones:
//        a) Audit-emit RULE_CHANGE_DETECTED
//        b) Index into the pgvector corpus (chunk → embed → upsert)
//        c) Fan out one ClassifyJob per active client
//        d) Mark dedup so a second crawl within the dedup window
//           doesn't re-emit
//
// The dedup mark is LAST so that a crash mid-flight means the next
// crawl tries again — avoids "we crashed after dedup but before
// classify enqueue" dropping the change silently.
//

export interface CrawlHandlerDeps {
  readonly crawlers: CrawlerRegistry;
  readonly dedup: DedupPort;
  readonly indexer: CorpusIndexer;
  readonly clients: ClientsPort;
  readonly classifyQueue: QueueProvider;
  readonly audit: AuditPort;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export function createCrawlHandler(deps: CrawlHandlerDeps): JobHandler {
  const { crawlers, dedup, indexer, clients, classifyQueue, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

  return async (job) => {
    const parsed = CrawlJob.safeParse(job.data);
    if (!parsed.success) {
      logger.error("crawl job payload failed schema", { jobId: job.id });
      throw new Error("crawl job payload failed schema");
    }
    const { source } = parsed.data;
    const crawler = crawlers.get(source);
    if (!crawler) {
      logger.error("crawl job for unknown source", { source });
      throw new Error(`unknown crawler source: ${source}`);
    }
    const activeClients = await clients.listActive();
    if (activeClients.length === 0) {
      logger.warn("no active clients — skipping classify fan-out", { source });
    }

    const changes = await crawler.crawl();
    logger.info("crawl complete", { source, changeCount: changes.length });

    for (const change of changes) {
      const alreadySeen = await dedup.seen(change.sourceId, change.contentHash);
      if (alreadySeen) continue;

      try {
        await audit.emit({
          type: "RULE_CHANGE_DETECTED",
          eventId: randomUUID(),
          timestamp: now().toISOString(),
          clientId: "_system",
          sourceId: change.sourceId,
          contentHash: change.contentHash,
          title: change.title,
          url: change.url,
        });

        await indexer.indexRuleChange(change);

        for (const client of activeClients) {
          const classifyPayload: ClassifyJob = {
            clientId: client.clientId,
            ruleChange: change,
          };
          await classifyQueue.enqueue("classify", classifyPayload);
        }

        // Mark dedup LAST — a crash before this point means we replay
        // the change next crawl, which is cheap. Marking first would
        // lose the change forever if we crashed before classify enqueue.
        await dedup.markSeen(change.sourceId, change.contentHash, {
          url: change.url,
          title: change.title,
          firstSeenAt: now().toISOString(),
        });
      } catch (err) {
        logger.error("crawl handler: change processing failed", {
          source: change.sourceId,
          contentHash: change.contentHash,
          error: err instanceof Error ? err.message : String(err),
        });
        // Re-throw so the whole crawl job goes to retry. Remaining
        // changes in this crawl will be re-processed on retry; dedup
        // handles idempotency for already-classified ones.
        throw err;
      }
    }
  };
}
