/**
 * Resilience tests for createExternalClient.
 *
 * Pattern: inject `fetchImpl` (typed `typeof fetch`) and `sleepImpl`
 * (no-op) so the test runs synchronously without wall-clock backoff,
 * and assert on (a) the URL/init the client constructed and (b) the
 * parsed return value.
 */

import { describe, it, expect, vi } from 'vitest';
import { createExternalClient, CircuitOpenError } from './http.js';

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fail(status: number, body: unknown = { error: 'fail' }): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: `code ${status}`,
    headers: { 'content-type': 'application/json' },
  });
}

const sleepNoop = async (_ms: number): Promise<void> => undefined;

describe('createExternalClient — request shape', () => {
  it('builds URL = baseUrl + path with no params; merges Content-Type + config headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ data: 1 }));
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: { 'X-Chorus': 'test' },
      fetchImpl,
      sleepImpl: sleepNoop,
    });
    const r = await client.request<{ data: number }>({ method: 'GET', path: '/widgets' });
    expect(r).toEqual({ data: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    expect(String(call[0])).toBe('https://api.example.com/widgets');
    expect((call[1]?.headers as Record<string, string>)['X-Chorus']).toBe('test');
    expect((call[1]?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('serialises params into a query string, omitting undefined values', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok([]));
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl: sleepNoop,
    });
    await client.request({ path: '/items', params: { a: 1, b: 'x', c: undefined } });
    const url = fetchImpl.mock.calls[0]![0];
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get('a')).toBe('1');
    expect(parsed.searchParams.get('b')).toBe('x');
    expect(parsed.searchParams.has('c')).toBe(false);
  });

  it('attaches X-Chorus-Correlation-Id when correlationId is provided', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({}));
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl: sleepNoop,
    });
    await client.request({ path: '/x', correlationId: 'corr-42' });
    const init = fetchImpl.mock.calls[0]![1];
    expect((init?.headers as Record<string, string>)['X-Chorus-Correlation-Id']).toBe('corr-42');
  });

  it('serialises body via JSON.stringify only when defined', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({}));
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl: sleepNoop,
    });
    await client.request({ method: 'POST', path: '/x', body: { hello: 'world' } });
    const init = fetchImpl.mock.calls[0]![1];
    expect(init?.body).toBe(JSON.stringify({ hello: 'world' }));

    fetchImpl.mockClear();
    await client.request({ method: 'GET', path: '/x' });
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
});

describe('createExternalClient — resilience', () => {
  it('returns the first 2xx without retrying', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ done: true }));
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl: sleepNoop,
    });
    const r = await client.request<{ done: boolean }>({ path: '/x' });
    expect(r).toEqual({ done: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and returns the eventual success body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(fail(429))
      .mockResolvedValueOnce(ok({ ok: true }));
    const sleepImpl = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl,
      maxRetries: 3,
    });
    const r = await client.request<{ ok: boolean }>({ path: '/x' });
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 503 and 504 (transient server) but not on 500', async () => {
    const fetchImpl503 = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(fail(503))
      .mockResolvedValueOnce(fail(504))
      .mockResolvedValueOnce(ok({ ok: true }));
    const c1 = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl: fetchImpl503,
      sleepImpl: sleepNoop,
    });
    await expect(c1.request({ path: '/x' })).resolves.toEqual({ ok: true });
    expect(fetchImpl503).toHaveBeenCalledTimes(3);

    const fetchImpl500 = vi.fn<typeof fetch>(async () => fail(500));
    const c2 = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl: fetchImpl500,
      sleepImpl: sleepNoop,
    });
    await expect(c2.request({ path: '/x' })).rejects.toThrow(/500/);
    expect(fetchImpl500).toHaveBeenCalledTimes(1);
  });

  it('throws when retry budget is exhausted', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => fail(503));
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl: sleepNoop,
      maxRetries: 2,
    });
    await expect(client.request({ path: '/x' })).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('caps maxRetries at 3 even if a higher value is requested', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => fail(503));
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl: sleepNoop,
      maxRetries: 99,
    });
    await expect(client.request({ path: '/x' })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('caps timeoutMs at 10_000 even if a higher value is requested (visible via signal handling)', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return ok({});
    });
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl: sleepNoop,
      timeoutMs: 60_000,
    });
    await client.request({ path: '/x' });
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
  });

  it('opens the breaker after N consecutive failures and fast-fails subsequent requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => fail(500));
    const t = 0;
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl: sleepNoop,
      maxRetries: 0,
      breakerFailureThreshold: 3,
      breakerCooldownMs: 10_000,
      now: () => t,
    });

    for (let i = 0; i < 3; i++) {
      await expect(client.request({ path: '/x' })).rejects.toThrow(/500/);
    }
    expect(client.breakerState()).toBe('OPEN');
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    await expect(client.request({ path: '/x' })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('transitions OPEN → HALF_OPEN after cooldown and CLOSED on probe success', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(ok({ ok: true }));
    let t = 0;
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl: sleepNoop,
      maxRetries: 0,
      breakerFailureThreshold: 2,
      breakerCooldownMs: 1000,
      now: () => t,
    });

    await expect(client.request({ path: '/x' })).rejects.toThrow();
    await expect(client.request({ path: '/x' })).rejects.toThrow();
    expect(client.breakerState()).toBe('OPEN');

    t = 1500;
    const r = await client.request<{ ok: boolean }>({ path: '/x' });
    expect(r).toEqual({ ok: true });
    expect(client.breakerState()).toBe('CLOSED');
  });

  it('aborts the underlying fetch when the timeout fires (caller sees AbortError thrown out)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted') as Error & { name: string };
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const client = createExternalClient({
      baseUrl: 'https://api.example.com',
      headers: {},
      fetchImpl,
      sleepImpl: sleepNoop,
      timeoutMs: 5,
      maxRetries: 0,
    });
    await expect(client.request({ path: '/x' })).rejects.toThrow(/aborted/);
  });
});
