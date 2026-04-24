import type { Logger } from "../logger.js";
import type { MemoRecord } from "../memo/types.js";
import type { PublishedPage, PublisherPort } from "./types.js";

// ── Confluence publisher ───────────────────────────────────────────
//
// Creates a new page under the client-configured Confluence space.
// Body is converted from markdown to Confluence's "storage" format
// (HTML-like XML). Keeps the conversion narrow — paragraphs +
// headings + bullets. For anything richer, operators can edit
// post-publish.
//
// Auth: basic (email:api-token) — the standard Atlassian REST
// pattern. Fork for OAuth if multi-org identity is needed.
//

export interface ConfluencePublisherDeps {
  readonly host: string; // e.g. "your-site.atlassian.net"
  readonly email: string;
  readonly apiToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  readonly timeoutMs?: number;
}

export function createConfluencePublisher(deps: ConfluencePublisherDeps): PublisherPort {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const { host, email, apiToken, logger } = deps;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");

  return {
    destination: "confluence",
    async publish(memo: MemoRecord, spaceKey: string): Promise<PublishedPage> {
      const response = await fetchImpl(`https://${host}/wiki/rest/api/content`, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "page",
          title: memo.title.slice(0, 250),
          space: { key: spaceKey },
          body: {
            storage: {
              representation: "storage",
              value: markdownToConfluenceStorage(memo.body),
            },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const errText = await response.text();
        logger.error("confluence publish failed", {
          memoId: memo.memoId,
          status: response.status,
          body: errText.slice(0, 500),
        });
        throw new Error(`confluence HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }
      const parsed = (await response.json()) as {
        id?: string;
        _links?: { base?: string; webui?: string };
      };
      if (!parsed.id || !parsed._links?.base || !parsed._links?.webui) {
        throw new Error("confluence response missing id or _links");
      }
      return {
        pageId: parsed.id,
        pageUrl: parsed._links.base + parsed._links.webui,
        destination: "confluence",
      };
    },
  };
}

/** Escape HTML-relevant characters. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Narrow markdown → Confluence storage format. */
function markdownToConfluenceStorage(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) {
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${escapeHtml(heading[2]!)}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`  <li>${escapeHtml(bullet[1]!)}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${escapeHtml(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}
