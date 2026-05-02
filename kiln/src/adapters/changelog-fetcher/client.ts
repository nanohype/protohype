// Changelog HTTPS fetcher. Allowlist-gated (SSRF prevention), explicit timeout,
// caller controls cache (the cache port is separate).

import { isChangelogHostAllowed } from "../../core/changelog/allowlist.js";
import type { ChangelogFetcherPort } from "../../core/ports.js";
import { err, ok } from "../../types.js";

export interface ChangelogFetcherConfig {
  timeoutMs: number;
  userAgent: string;
}

export function makeChangelogFetcher(cfg: ChangelogFetcherConfig): ChangelogFetcherPort {
  return {
    async fetch(url) {
      if (!isChangelogHostAllowed(url)) {
        return err({ kind: "Forbidden", source: "changelog", message: `host not in allowlist: ${url}` });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const resp = await fetch(url, {
          redirect: "follow",
          signal: controller.signal,
          headers: { "user-agent": cfg.userAgent, accept: "text/markdown, text/plain, */*" },
        });
        if (resp.status === 404) return ok(null);
        if (!resp.ok) {
          return err({
            kind: "Upstream",
            source: "changelog",
            status: resp.status,
            message: `fetch failed ${resp.status} ${resp.statusText}`,
          });
        }
        const body = await resp.text();
        const etag = resp.headers.get("etag") ?? undefined;
        return ok(etag ? { body, etag } : { body });
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") {
          return err({ kind: "Timeout", source: "changelog", timeoutMs: cfg.timeoutMs });
        }
        return err({ kind: "Upstream", source: "changelog", message: asMessage(e) });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
