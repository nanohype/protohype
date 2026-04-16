/**
 * Codebase scanner — finds usage sites of a dependency's symbols in a GitHub repo.
 * Returns file:line references for symbols that appear in breaking changes.
 * Uses GitHub's Search API (code search) to avoid cloning repos.
 */
import { fetchWithTimeout } from "../github/app.js";
import { consumeGitHubTokens } from "../github/rate-limiter.js";
import { config } from "../../config.js";
import { log } from "../../telemetry/otel.js";
import type { UsageSite, BreakingChange } from "../../types.js";

const GH_API = "https://api.github.com";
const GH_SEARCH_API = "https://api.github.com/search/code";

interface SearchResult {
  total_count: number;
  items: Array<{
    path: string;
    repository: { full_name: string };
    url: string;
  }>;
}

/**
 * Scan a GitHub repo for usage sites of symbols affected by breaking changes.
 * Returns at most 100 usage sites to bound the Bedrock context window.
 */
export async function scanUsageSites(
  owner: string,
  repo: string,
  dep: string,
  breakingChanges: BreakingChange[],
  installationToken: string,
): Promise<UsageSite[]> {
  const headers = {
    Authorization: `token ${installationToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const usageSites: UsageSite[] = [];
  const symbols = extractSymbols(breakingChanges);

  if (symbols.length === 0) {
    log("info", "No symbols to search for", { dep, owner, repo });
    return [];
  }

  for (const symbol of symbols.slice(0, 10)) {
    // Limit to 10 symbols per upgrade to keep search API usage reasonable
    try {
      await consumeGitHubTokens(1);
      const query = `${symbol} repo:${owner}/${repo} language:TypeScript language:JavaScript`;
      const resp = await fetchWithTimeout(
        `${GH_SEARCH_API}?q=${encodeURIComponent(query)}&per_page=10`,
        { headers },
        config.github.readTimeoutMs,
      );

      if (!resp.ok) {
        log("warn", "Code search failed", { symbol, status: resp.status });
        continue;
      }

      const data = (await resp.json()) as SearchResult;

      for (const item of data.items.slice(0, 5)) {
        const fileSites = await getFileSitesForSymbol(
          item.path,
          item.url,
          symbol,
          headers,
        );
        usageSites.push(...fileSites);
      }
    } catch (err) {
      log("warn", "Symbol search error", { symbol, err: String(err) });
    }

    if (usageSites.length >= 100) break;
  }

  return usageSites.slice(0, 100);
}

async function getFileSitesForSymbol(
  filePath: string,
  contentUrl: string,
  symbol: string,
  headers: Record<string, string>,
): Promise<UsageSite[]> {
  try {
    await consumeGitHubTokens(1);
    const resp = await fetchWithTimeout(contentUrl, { headers }, config.github.readTimeoutMs);
    if (!resp.ok) return [];

    const data = (await resp.json()) as { content?: string };
    if (!data.content) return [];

    const fileContent = Buffer.from(data.content, "base64").toString("utf-8");
    const lines = fileContent.split("\n");
    const sites: UsageSite[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes(symbol)) {
        sites.push({
          filePath,
          lineNumber: i + 1,
          lineContent: line.trim(),
          symbol,
        });
      }
    }

    return sites;
  } catch (err) {
    log("warn", "Failed to fetch file content", { filePath, err: String(err) });
    return [];
  }
}

function extractSymbols(breakingChanges: BreakingChange[]): string[] {
  const symbols = new Set<string>();
  for (const bc of breakingChanges) {
    if (bc.affectedSymbol) {
      // Strip package prefixes — we want just the symbol name for code search
      const sym = bc.affectedSymbol.split(".").pop() ?? bc.affectedSymbol;
      if (sym.length > 2) symbols.add(sym);
    }
  }
  return [...symbols];
}
