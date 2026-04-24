import type { Logger } from "../logger.js";
import { createCircuitBreaker, type CircuitBreaker } from "../resilience/circuit-breaker.js";

// ── HTTP client helper ─────────────────────────────────────────────
//
// Every crawler wraps its HTTP calls in a per-source circuit breaker
// + deadline. A flaky regulator feed opens the breaker after N
// consecutive failures — the crawler skips that source for
// `resetTimeout` before attempting a half-open probe. Protects
// both the upstream feed (avoids hammering it during their outage)
// and watchtower (avoids wasting worker time on known-down sources).
//

export interface HttpFetcherDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  readonly logger: Logger;
}

export interface HttpFetcher {
  readonly breaker: CircuitBreaker;
  /** GET `url`, return text body. Throws on non-2xx, timeout, or open breaker. */
  getText(url: string): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT =
  "watchtower/0.1.0 (regulatory change radar; +https://github.com/nanohype/protohype)";

export function createHttpFetcher(deps: HttpFetcherDeps): HttpFetcher {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  const breaker = createCircuitBreaker();
  const logger = deps.logger;

  async function getText(url: string): Promise<string> {
    return breaker.call(async () => {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { "User-Agent": userAgent, Accept: "application/xml, text/xml, */*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        logger.warn("crawler http non-2xx", { url, status: response.status });
        throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
      }
      return response.text();
    });
  }

  return { breaker, getText };
}
