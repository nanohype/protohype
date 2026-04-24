import type { Logger } from "../logger.js";
import type { HttpFetcher } from "./http.js";
import { createRssAtomCrawler } from "./rss.js";
import type { Crawler } from "./types.js";

// ── Known regulator feeds ──────────────────────────────────────────
//
// Seed set — extend per client. Fork to add/remove sources. The
// Dockerfile's EventBridge Scheduler (in `infra/lib/watchtower-stack.ts`)
// enqueues a `{ source }` message on the crawl queue matching one of
// these `sourceId`s.
//

export const DEFAULT_FEEDS = {
  "sec-edgar":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=&company=&dateb=&owner=include&count=40&output=atom",
  cfpb: "https://www.consumerfinance.gov/about-us/newsroom/feed/",
  ofac: "https://home.treasury.gov/system/files/126/sdn_advanced.xml",
  edpb: "https://www.edpb.europa.eu/news/news_en.rss",
} as const;

export type DefaultSourceId = keyof typeof DEFAULT_FEEDS;

export function createDefaultCrawlers(deps: { fetcher: HttpFetcher; logger: Logger }): Crawler[] {
  const { fetcher, logger } = deps;
  return (Object.keys(DEFAULT_FEEDS) as DefaultSourceId[]).map((sourceId) =>
    createRssAtomCrawler({
      sourceId,
      feedUrl: DEFAULT_FEEDS[sourceId],
      fetcher,
      logger: logger.child(`crawler.${sourceId}`),
    }),
  );
}
