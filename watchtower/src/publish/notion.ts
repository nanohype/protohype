import type { Logger } from "../logger.js";
import type { MemoRecord } from "../memo/types.js";
import type { PublishedPage, PublisherPort } from "./types.js";

// ── Notion publisher ───────────────────────────────────────────────
//
// Creates a new page under the client-configured Notion database.
// Body converts from markdown → a small subset of Notion block types
// (paragraphs + headings + bullet lists). For rich tables or inline
// embeds the plan is to let the memo body keep raw markdown in a
// single `code` block — tradeoff between fidelity and implementation
// effort.
//
// Auth: bearer token from the client config. Fork to use OAuth v2
// delegation instead of a static secret.
//

const NOTION_API_VERSION = "2022-06-28";
const NOTION_BASE_URL = "https://api.notion.com/v1";

export interface NotionPublisherDeps {
  readonly apiToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

export function createNotionPublisher(deps: NotionPublisherDeps): PublisherPort {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const baseUrl = deps.baseUrl ?? NOTION_BASE_URL;
  const logger = deps.logger;

  return {
    destination: "notion",
    async publish(memo: MemoRecord, databaseId: string): Promise<PublishedPage> {
      const response = await fetchImpl(`${baseUrl}/pages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.apiToken}`,
          "Notion-Version": NOTION_API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties: {
            Name: {
              title: [{ type: "text", text: { content: memo.title.slice(0, 2000) } }],
            },
          },
          children: markdownToNotionBlocks(memo.body),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const errText = await response.text();
        logger.error("notion publish failed", {
          memoId: memo.memoId,
          status: response.status,
          body: errText.slice(0, 500),
        });
        throw new Error(`notion HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }
      const parsed = (await response.json()) as { id?: string; url?: string };
      if (!parsed.id || !parsed.url) {
        throw new Error("notion response missing id or url");
      }
      return { pageId: parsed.id, pageUrl: parsed.url, destination: "notion" };
    },
  };
}

/** Minimal markdown → Notion block conversion. Paragraphs + h1/h2/h3 + bullets. */
function markdownToNotionBlocks(markdown: string): unknown[] {
  const lines = markdown.split("\n");
  const blocks: unknown[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      blocks.push({
        object: "block",
        type: `heading_${level}`,
        [`heading_${level}`]: {
          rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }],
        },
      });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: bullet[1]!.slice(0, 2000) } }],
        },
      });
      continue;
    }
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: line.slice(0, 2000) } }],
      },
    });
  }
  return blocks;
}
