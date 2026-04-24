import type { Crawler } from "./types.js";

// ── Crawler registry ───────────────────────────────────────────────
//
// Maps sourceId → Crawler. The crawl stage handler reads the source
// name off its SQS message body and looks up the registered crawler.
// Fork this for a different client by registering different feeds;
// everything downstream is source-agnostic.
//

export interface CrawlerRegistry {
  register(crawler: Crawler): void;
  get(sourceId: string): Crawler | undefined;
  list(): readonly Crawler[];
}

export function createCrawlerRegistry(initial: readonly Crawler[] = []): CrawlerRegistry {
  const entries = new Map<string, Crawler>();
  for (const c of initial) entries.set(c.sourceId, c);
  return {
    register(crawler) {
      entries.set(crawler.sourceId, crawler);
    },
    get(sourceId) {
      return entries.get(sourceId);
    },
    list() {
      return [...entries.values()];
    },
  };
}
