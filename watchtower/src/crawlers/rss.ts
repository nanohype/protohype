import { XMLParser } from "fast-xml-parser";
import type { Logger } from "../logger.js";
import type { Crawler, RuleChange } from "./types.js";
import type { HttpFetcher } from "./http.js";
import { hashRuleChange } from "./hash.js";

// ── Generic RSS/Atom crawler ───────────────────────────────────────
//
// Most regulator feeds are RSS 2.0 or Atom. This factory takes a URL
// and an `HttpFetcher` and produces a `Crawler` that yields one
// `RuleChange` per feed item. Source-specific tweaks (custom fields,
// HTML body extraction) get handled by the optional `itemTransform`.
//
// The parser is permissive — if a feed mixes namespaces (`<dc:date>`,
// `<content:encoded>`), both paths are tried. Items missing a hard
// requirement (title or link) are dropped with a `warn`; the crawler
// does not abort the whole feed on one bad item.
//

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: true,
  parseAttributeValue: false,
});

export interface RssCrawlerDeps {
  readonly sourceId: string;
  readonly feedUrl: string;
  readonly fetcher: HttpFetcher;
  readonly logger: Logger;
  /**
   * Per-item customization — called on each parsed item before a
   * `RuleChange` is built. Return `null` to drop the item (e.g.
   * filter out a sub-topic watchtower doesn't track).
   */
  readonly itemTransform?: (item: RawItem) => Partial<RawItem> | null;
}

export type RawItem = {
  title?: string | undefined;
  link?: string | undefined;
  guid?: string | undefined;
  pubDate?: string | undefined;
  description?: string | undefined;
  summary?: string | undefined;
  content?: string | undefined;
  contentEncoded?: string | undefined;
  raw?: Record<string, unknown> | undefined;
};

export function createRssAtomCrawler(deps: RssCrawlerDeps): Crawler {
  const { sourceId, feedUrl, fetcher, logger, itemTransform } = deps;

  return {
    sourceId,
    async crawl(): Promise<readonly RuleChange[]> {
      const xml = await fetcher.getText(feedUrl);
      const parsed = xmlParser.parse(xml) as Record<string, unknown>;
      const items = extractItems(parsed);
      const changes: RuleChange[] = [];

      for (const raw of items) {
        const normalized = normalizeItem(raw);
        let transformed: RawItem | null;
        if (itemTransform) {
          const result = itemTransform(normalized);
          transformed = result === null ? null : { ...normalized, ...result };
        } else {
          transformed = normalized;
        }
        if (transformed === null) continue;

        const title = (transformed.title ?? "").trim();
        const url = (transformed.link ?? "").trim();
        if (!title || !url) {
          logger.warn("crawler skipping item missing title or link", {
            sourceId,
            title,
            url,
          });
          continue;
        }

        const body = (
          transformed.contentEncoded ??
          transformed.content ??
          transformed.description ??
          ""
        )
          .toString()
          .trim();
        const publishedAt = normalizeDate(transformed.pubDate);

        changes.push({
          sourceId,
          contentHash: hashRuleChange(title, url, body),
          title,
          url,
          publishedAt,
          summary: (transformed.summary ?? transformed.description ?? "").toString().trim(),
          body,
          rawMetadata: transformed.raw ?? {},
        });
      }
      return changes;
    },
  };
}

function extractItems(parsed: Record<string, unknown>): RawItem[] {
  // RSS 2.0: rss > channel > item[]
  const rss = parsed.rss as Record<string, unknown> | undefined;
  if (rss?.channel) {
    const channel = rss.channel as Record<string, unknown>;
    return asArray(channel.item).map((i) => i as RawItem);
  }
  // Atom: feed > entry[]
  const feed = parsed.feed as Record<string, unknown> | undefined;
  if (feed?.entry) {
    return asArray(feed.entry).map(atomToRaw);
  }
  return [];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeItem(item: RawItem | Record<string, unknown>): RawItem {
  const base = item as Record<string, unknown>;
  return {
    title: stringOf(base.title),
    link:
      typeof base.link === "string"
        ? base.link
        : stringOf((base.link as { "@_href"?: string })?.["@_href"] ?? base.link),
    guid: stringOf(base.guid),
    pubDate: stringOf(base.pubDate ?? base.published ?? base.updated ?? base["dc:date"]),
    description: stringOf(base.description ?? base.summary),
    summary: stringOf(base.summary ?? base.description),
    content: stringOf(base.content),
    contentEncoded: stringOf(base["content:encoded"]),
    raw: base,
  };
}

function atomToRaw(entry: unknown): RawItem {
  const e = entry as Record<string, unknown>;
  const rawLink = e.link as
    | { "@_href"?: string }
    | string
    | Array<{ "@_href"?: string }>
    | undefined;
  let linkHref: string | undefined;
  if (typeof rawLink === "string") linkHref = rawLink;
  else if (Array.isArray(rawLink)) linkHref = rawLink[0]?.["@_href"];
  else if (rawLink && typeof rawLink === "object") linkHref = rawLink["@_href"];
  return {
    title: stringOf(e.title),
    link: linkHref,
    guid: stringOf(e.id),
    pubDate: stringOf(e.updated ?? e.published),
    description: stringOf(e.summary),
    summary: stringOf(e.summary),
    content: stringOf(e.content),
    raw: e,
  };
}

function stringOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "#text" in (v as object)) {
    return stringOf((v as { "#text": unknown })["#text"]);
  }
  return undefined;
}

function normalizeDate(input: string | undefined): string {
  if (!input) return new Date().toISOString();
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}
