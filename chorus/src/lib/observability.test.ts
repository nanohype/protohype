import { describe, it, expect, vi } from 'vitest';
import { correlationMiddleware, withCorrelation, type CorrelatedRequest } from './observability.js';
import type { Response, NextFunction } from 'express';

function makeReq(headers: Record<string, string | string[]> = {}): CorrelatedRequest {
  return { headers } as unknown as CorrelatedRequest;
}

function makeRes(): Response & { _headers: Record<string, string> } {
  const _headers: Record<string, string> = {};
  return {
    _headers,
    setHeader: (k: string, v: string) => {
      _headers[k] = v;
    },
  } as unknown as Response & { _headers: Record<string, string> };
}

describe('correlationMiddleware', () => {
  it('uses the inbound x-chorus-correlation-id when present', () => {
    const req = makeReq({ 'x-chorus-correlation-id': 'inbound-42' });
    const res = makeRes();
    const next = vi.fn();
    correlationMiddleware(req, res, next as NextFunction);
    expect(req.correlationId).toBe('inbound-42');
    expect(res._headers['X-Chorus-Correlation-Id']).toBe('inbound-42');
    expect(next).toHaveBeenCalledOnce();
  });

  it('generates a UUID v4 when no inbound header is present', () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    correlationMiddleware(req, res, next as NextFunction);
    expect(req.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res._headers['X-Chorus-Correlation-Id']).toBe(req.correlationId);
  });

  it('falls through to UUID when the inbound header is an array (untrusted shape)', () => {
    const req = makeReq({ 'x-chorus-correlation-id': ['a', 'b'] });
    const res = makeRes();
    correlationMiddleware(req, res, vi.fn() as unknown as NextFunction);
    expect(req.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('withCorrelation', () => {
  it('returns the value of the wrapped function (no transform)', async () => {
    const r = await withCorrelation('c-1', 'EMBED', async () => 42);
    expect(r).toBe(42);
  });

  it('propagates rejection from the wrapped function', async () => {
    await expect(
      withCorrelation('c-1', 'MATCH', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
