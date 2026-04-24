import { describe, it, expect, vi } from "vitest";
import { createHttpFetcher } from "./http.js";
import { createRssAtomCrawler } from "./rss.js";
import { createCrawlerRegistry } from "./registry.js";
import { hashRuleChange } from "./hash.js";
import { createFakeDedup } from "./dedup.js";
import { createLogger } from "../logger.js";

const silent = createLogger("error", "crawler-test");

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>SEC EDGAR Current Events</title>
  <entry>
    <title>Proposed rule: Enhanced broker-dealer disclosure</title>
    <link href="https://www.sec.gov/news/release/proposed-1"/>
    <id>urn:sec:release:1</id>
    <updated>2026-04-20T10:00:00Z</updated>
    <summary>Rule 15c3-1 proposed amendment covering intraday capital requirements.</summary>
    <content>Full text of the proposal…</content>
  </entry>
  <entry>
    <title>Enforcement action vs. Example Corp</title>
    <link href="https://www.sec.gov/news/enforce-2"/>
    <id>urn:sec:enforce:2</id>
    <updated>2026-04-21T09:30:00Z</updated>
    <summary>Example Corp to pay $5M penalty for disclosure failures.</summary>
  </entry>
</feed>`;

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>CFPB News</title>
    <item>
      <title>CFPB issues new guidance on overdraft fees</title>
      <link>https://www.consumerfinance.gov/newsroom/overdraft</link>
      <guid>https://www.consumerfinance.gov/newsroom/overdraft</guid>
      <pubDate>Mon, 21 Apr 2026 14:00:00 GMT</pubDate>
      <description>New rule targets junk fees on consumer checking accounts.</description>
    </item>
  </channel>
</rss>`;

function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () => {
    return new Response(body, { status, headers: { "Content-Type": "application/xml" } });
  }) as typeof fetch;
}

describe("hashRuleChange", () => {
  it("is stable across whitespace variations in the body", () => {
    const a = hashRuleChange("T", "https://x", "a  b\tc");
    const b = hashRuleChange("T", "https://x", "a b c");
    expect(a).toBe(b);
  });

  it("changes when the title changes", () => {
    const a = hashRuleChange("Title A", "https://x", "body");
    const b = hashRuleChange("Title B", "https://x", "body");
    expect(a).not.toBe(b);
  });
});

describe("createRssAtomCrawler", () => {
  it("parses Atom entries into RuleChanges", async () => {
    const fetcher = createHttpFetcher({ fetchImpl: fakeFetch(ATOM_FIXTURE), logger: silent });
    const crawler = createRssAtomCrawler({
      sourceId: "sec-edgar",
      feedUrl: "https://example.com/feed.atom",
      fetcher,
      logger: silent,
    });
    const changes = await crawler.crawl();
    expect(changes).toHaveLength(2);
    expect(changes[0]!.sourceId).toBe("sec-edgar");
    expect(changes[0]!.title).toContain("Proposed rule");
    expect(changes[0]!.url).toBe("https://www.sec.gov/news/release/proposed-1");
    expect(changes[0]!.publishedAt).toMatch(/^2026-04-20/);
  });

  it("parses RSS 2.0 items into RuleChanges", async () => {
    const fetcher = createHttpFetcher({ fetchImpl: fakeFetch(RSS_FIXTURE), logger: silent });
    const crawler = createRssAtomCrawler({
      sourceId: "cfpb",
      feedUrl: "https://example.com/feed.rss",
      fetcher,
      logger: silent,
    });
    const changes = await crawler.crawl();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.title).toContain("overdraft fees");
  });

  it("drops items missing title or link with a warn", async () => {
    const bad = `<?xml version="1.0"?><rss version="2.0"><channel><item></item></channel></rss>`;
    const fetcher = createHttpFetcher({ fetchImpl: fakeFetch(bad), logger: silent });
    const warnings: unknown[] = [];
    const logger = { ...silent, warn: (_msg: string, data?: unknown) => warnings.push(data) };
    const crawler = createRssAtomCrawler({
      sourceId: "test",
      feedUrl: "https://example.com/feed.rss",
      fetcher,
      logger,
    });
    const changes = await crawler.crawl();
    expect(changes).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it("trips the breaker on repeated 500s instead of hammering the source", async () => {
    const fetcher = createHttpFetcher({
      fetchImpl: fakeFetch("gateway error", 502),
      logger: silent,
    });
    const crawler = createRssAtomCrawler({
      sourceId: "flaky",
      feedUrl: "https://example.com/flaky.rss",
      fetcher,
      logger: silent,
    });
    // Default breaker threshold = 5
    for (let i = 0; i < 5; i++) {
      await expect(crawler.crawl()).rejects.toThrow(/HTTP 502|Circuit breaker/);
    }
    await expect(crawler.crawl()).rejects.toThrow(/Circuit breaker is open/);
    expect(fetcher.breaker.state).toBe("open");
  });

  it("applies itemTransform and drops on null return", async () => {
    const fetcher = createHttpFetcher({ fetchImpl: fakeFetch(ATOM_FIXTURE), logger: silent });
    const crawler = createRssAtomCrawler({
      sourceId: "sec-filter",
      feedUrl: "https://example.com/feed.atom",
      fetcher,
      logger: silent,
      itemTransform: (item) => (item.title?.includes("Enforcement") ? null : item),
    });
    const changes = await crawler.crawl();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.title).toContain("Proposed rule");
  });
});

describe("createCrawlerRegistry", () => {
  it("registers and looks up by sourceId", async () => {
    const fetcher = createHttpFetcher({ fetchImpl: fakeFetch(RSS_FIXTURE), logger: silent });
    const c = createRssAtomCrawler({ sourceId: "cfpb", feedUrl: "x", fetcher, logger: silent });
    const reg = createCrawlerRegistry([c]);
    expect(reg.get("cfpb")).toBe(c);
    expect(reg.get("unknown")).toBeUndefined();
    expect(reg.list()).toHaveLength(1);
  });
});

describe("createFakeDedup", () => {
  it("markSeen is idempotent", async () => {
    const d = createFakeDedup();
    await d.markSeen("s", "h", { url: "u", title: "t", firstSeenAt: "2026-01-01T00:00:00Z" });
    await d.markSeen("s", "h", { url: "u2", title: "t2", firstSeenAt: "2026-01-02T00:00:00Z" });
    expect(await d.seen("s", "h")).toBe(true);
    expect(d.entries).toHaveLength(1);
  });
});

describe("dedup DDB adapter", () => {
  it("treats ConditionalCheckFailedException as already-marked (idempotent)", async () => {
    const { createDdbDedup } = await import("./dedup.js");
    const err = Object.assign(new Error("Conditional check failed"), {
      name: "ConditionalCheckFailedException",
    });
    const send = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve({})) // seen() path
      .mockImplementationOnce(() => Promise.reject(err)); // markSeen() path
    const ddb = { send } as unknown as Parameters<typeof createDdbDedup>[0]["ddb"];
    const dedup = createDdbDedup({ ddb, tableName: "d" });
    await dedup.seen("s", "h");
    await expect(
      dedup.markSeen("s", "h", { url: "u", title: "t", firstSeenAt: "2026" }),
    ).resolves.toBeUndefined();
  });
});
