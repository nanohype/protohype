import { CircuitBreaker } from "../resilience/circuit-breaker.js";
import { logger } from "../logger.js";

export interface FetchResult {
  url: string;
  html: string;
  statusCode: number;
  fetchedAt: Date;
  headers: Record<string, string>;
}

// Per-host circuit breakers so one flaky site doesn't block all sources.
const breakers = new Map<string, CircuitBreaker>();

function breakerFor(url: string): CircuitBreaker {
  const host = new URL(url).hostname;
  let breaker = breakers.get(host);
  if (!breaker) {
    breaker = new CircuitBreaker(`http:${host}`, {
      failureThreshold: 3,
      resetTimeoutMs: 120_000,
    });
    breakers.set(host, breaker);
  }
  return breaker;
}

export async function fetchPage(
  url: string,
  options: { timeoutMs: number; userAgent: string },
): Promise<FetchResult> {
  return breakerFor(url).execute(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      logger.debug("fetching", { url });

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": options.userAgent,
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      const html = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        headers[k] = v;
      });

      logger.info("fetched", { url, status: response.status, bytes: html.length });

      return {
        url,
        html,
        statusCode: response.status,
        fetchedAt: new Date(),
        headers,
      };
    } finally {
      clearTimeout(timeout);
    }
  });
}
