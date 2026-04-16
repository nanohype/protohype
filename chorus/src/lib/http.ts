/**
 * External HTTP client factory. Hard caps timeout at 10s, retries at
 * 3, jittered exponential backoff on 429/503/504. A per-client circuit
 * breaker fast-fails once the upstream has tripped, so a Linear or
 * Bedrock outage can't walk the caller through the full retry budget
 * on every request. Tests inject `fetchImpl`, `sleepImpl`, and `now`
 * so retry and breaker transitions run without wall-clock delay.
 *
 * Every request is wrapped in an OTel client span with the outbound
 * host, status code, retry attempt count, and breaker state attached
 * — the collector exports to Grafana Cloud as an HTTP client span.
 * The per-host breaker state also surfaces as an observable gauge so
 * dashboards can show when upstream is open-circuited.
 */

import { SpanKind, SpanStatusCode, type Attributes } from '@opentelemetry/api';
import { getTracer } from './telemetry.js';
import { setBreakerState } from './telemetry-hooks.js';

export interface ExternalClientConfig {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  retryDelayBaseMs?: number | undefined;
  /** Consecutive failures before the breaker opens. Defaults to 5. */
  breakerFailureThreshold?: number | undefined;
  /** How long the breaker stays OPEN before allowing one probe. Defaults to 30s. */
  breakerCooldownMs?: number | undefined;
  /** Inject the fetch implementation. Defaults to the global `fetch`.
   *  Tests pass `vi.fn<typeof fetch>(...)` and assert on the URL/init
   *  the client constructs. */
  fetchImpl?: typeof fetch;
  /** Inject the backoff sleep. Defaults to a real `setTimeout`-based
   *  sleep. Tests pass a no-op so retry tests don't wait wall-clock. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Clock used by the circuit breaker. Defaults to `Date.now`. */
  now?: () => number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  params?: Record<string, string | number | undefined>;
  correlationId?: string | undefined;
}

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface ExternalClient {
  request<T>(opts: RequestOptions): Promise<T>;
  /** Current breaker state — exposed for observability / tests. */
  breakerState(): BreakerState;
}

const RETRY_STATUS = new Set([429, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(base: number): number {
  const d = base * 0.25;
  return base - d + Math.random() * 2 * d;
}

export class CircuitOpenError extends Error {
  constructor(baseUrl: string) {
    super(`Circuit breaker OPEN for ${baseUrl}`);
    this.name = 'CircuitOpenError';
  }
}

export function createExternalClient(config: ExternalClientConfig): ExternalClient {
  const timeoutMs = Math.min(config.timeoutMs ?? 10_000, 10_000);
  const maxRetries = Math.min(config.maxRetries ?? 3, 3);
  const retryDelayBaseMs = config.retryDelayBaseMs ?? 500;
  const failureThreshold = config.breakerFailureThreshold ?? 5;
  const cooldownMs = config.breakerCooldownMs ?? 30_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleepImpl = config.sleepImpl ?? defaultSleep;
  const now = config.now ?? Date.now;

  const host = safeHost(config.baseUrl);
  let state: BreakerState = 'CLOSED';
  let consecutiveFailures = 0;
  let openedAt = 0;
  setBreakerState(host, state);

  function transition(next: BreakerState): void {
    if (state === next) return;
    state = next;
    setBreakerState(host, state);
  }

  function onSuccess(): void {
    consecutiveFailures = 0;
    transition('CLOSED');
  }

  function onFailure(): void {
    consecutiveFailures++;
    if (consecutiveFailures >= failureThreshold) {
      openedAt = now();
      transition('OPEN');
    }
  }

  function gate(): void {
    if (state === 'OPEN') {
      if (now() - openedAt >= cooldownMs) {
        transition('HALF_OPEN');
        return;
      }
      throw new CircuitOpenError(config.baseUrl);
    }
  }

  return {
    breakerState: () => state,
    async request<T>(opts: RequestOptions): Promise<T> {
      const method = opts.method ?? 'GET';
      const tracer = getTracer('chorus.http');
      const baseAttrs: Attributes = {
        'http.request.method': method,
        'server.address': host,
        'chorus.host': host,
      };
      return tracer.startActiveSpan(
        `HTTP ${method} ${host}`,
        { kind: SpanKind.CLIENT, attributes: baseAttrs },
        async (span) => {
          try {
            gate();

            let url = `${config.baseUrl}${opts.path}`;
            if (opts.params) {
              const entries: [string, string][] = Object.entries(opts.params)
                .filter((e): e is [string, string | number] => e[1] !== undefined)
                .map(([k, v]) => [k, String(v)]);
              const qs = new URLSearchParams(entries).toString();
              if (qs) url += `?${qs}`;
            }
            span.setAttribute('url.full', url);

            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              ...config.headers,
            };
            if (opts.correlationId) {
              headers['X-Chorus-Correlation-Id'] = opts.correlationId;
              span.setAttribute('chorus.correlation_id', opts.correlationId);
            }
            let attempt = 0;
            while (attempt <= maxRetries) {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeoutMs);
              try {
                const init: RequestInit = {
                  method,
                  headers,
                  signal: controller.signal,
                };
                if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
                const response = await fetchImpl(url, init);
                span.setAttribute('http.response.status_code', response.status);
                if (!response.ok) {
                  if (RETRY_STATUS.has(response.status) && attempt < maxRetries) {
                    attempt++;
                    span.setAttribute('chorus.retry.attempt', attempt);
                    await sleepImpl(jitter(retryDelayBaseMs * Math.pow(2, attempt - 1)));
                    continue;
                  }
                  throw new Error(`HTTP ${response.status} from ${url}`);
                }
                onSuccess();
                span.setAttribute('chorus.breaker.state', state);
                span.setStatus({ code: SpanStatusCode.OK });
                return (await response.json()) as T;
              } catch (err) {
                if (err instanceof Error && err.name === 'AbortError' && attempt < maxRetries) {
                  attempt++;
                  span.setAttribute('chorus.retry.attempt', attempt);
                  await sleepImpl(jitter(retryDelayBaseMs * Math.pow(2, attempt - 1)));
                  continue;
                }
                onFailure();
                throw err;
              } finally {
                clearTimeout(timer);
              }
            }
            onFailure();
            throw new Error(`Max retries exceeded for ${url}`);
          } catch (err) {
            span.setAttribute('chorus.breaker.state', state);
            span.recordException(err as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
            throw err;
          } finally {
            span.end();
          }
        },
      );
    },
  };
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
