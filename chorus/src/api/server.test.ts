import { describe, it, expect, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './server.js';
import type { ProposalsRepository } from './proposals-repository.js';
import type { LinearSync } from '../ingestion/linear-sync.js';
import type { PipelineDeps } from '../ingestion/pipeline.js';

function fakes(): { repo: ProposalsRepository; linear: LinearSync; pipelineDeps: PipelineDeps } {
  return {
    repo: { list: vi.fn(), get: vi.fn(), setStatus: vi.fn() },
    linear: {
      mirror: vi.fn(),
      addComment: vi.fn(),
      createIssue: vi.fn(),
    },
    pipelineDeps: {
      db: { query: vi.fn() } as unknown as PipelineDeps['db'],
      matcherDeps: {} as PipelineDeps['matcherDeps'],
      dlq: { sendMessage: vi.fn() },
    },
  };
}

function start(deps: Parameters<typeof createApp>[0] = {}): {
  url: string;
  server: Server;
  close: () => Promise<void>;
} {
  const app = createApp({ ...fakes(), ...deps });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('createApp — helmet security headers', () => {
  it('sets the default helmet bundle on every response', async () => {
    const ctx = start();
    try {
      const r = await fetch(`${ctx.url}/healthz`);
      expect(r.status).toBe(200);
      // helmet defaults we care about — exact values can drift across
      // major versions, so assert on presence not value.
      expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('content-security-policy')).toBeTruthy();
      expect(r.headers.get('strict-transport-security')).toBeTruthy();
      expect(r.headers.get('referrer-policy')).toBeTruthy();
      expect(r.headers.get('x-powered-by')).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});

describe('createApp — CORS allowlist', () => {
  it('same-origin (no Origin header) always succeeds — health probe unaffected', async () => {
    const ctx = start({ corsAllowedOrigins: [] });
    try {
      const r = await fetch(`${ctx.url}/healthz`);
      expect(r.status).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  it('allowlisted Origin is echoed in Access-Control-Allow-Origin on the preflight', async () => {
    const ctx = start({ corsAllowedOrigins: ['https://chorus.acme.com'] });
    try {
      const r = await fetch(`${ctx.url}/api/proposals`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://chorus.acme.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Authorization',
        },
      });
      expect(r.headers.get('access-control-allow-origin')).toBe('https://chorus.acme.com');
      expect(r.headers.get('access-control-allow-credentials')).toBe('true');
      expect(r.status).toBeLessThan(300);
    } finally {
      await ctx.close();
    }
  });

  it('non-allowlisted Origin is rejected — no Access-Control-Allow-Origin echoed', async () => {
    const ctx = start({ corsAllowedOrigins: ['https://chorus.acme.com'] });
    try {
      const r = await fetch(`${ctx.url}/healthz`, {
        headers: { Origin: 'https://evil.example.com' },
      });
      // cors() calls next(err) on denial; our default error handler
      // returns 500 — what matters is that the ACAO header is absent,
      // so the browser refuses to surface the response to the caller.
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it('empty allowlist rejects every cross-origin request (fail closed)', async () => {
    const ctx = start({ corsAllowedOrigins: [] });
    try {
      const r = await fetch(`${ctx.url}/healthz`, {
        headers: { Origin: 'https://chorus.acme.com' },
      });
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});

describe('createApp — 404 fallback', () => {
  it('returns a JSON 404 on unknown routes', async () => {
    const ctx = start();
    try {
      const r = await fetch(`${ctx.url}/nope`);
      expect(r.status).toBe(404);
      expect(((await r.json()) as { error: string }).error).toBe('Not found');
    } finally {
      await ctx.close();
    }
  });
});
