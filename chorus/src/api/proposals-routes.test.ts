import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createProposalsRouter } from './proposals-routes.js';
import type { ProposalsRepository, ProposalSummary } from './proposals-repository.js';
import type { LinearSync } from '../ingestion/linear-sync.js';
import type { AuthClaims, AuthedRequest } from '../lib/auth.js';

/**
 * Test auth middleware: reads AuthClaims from a JSON header so each
 * test can declare its caller. Returns 401 if the header is absent or
 * malformed — same surface contract as the real requireAuth.
 */
function testAuth(): RequestHandler {
  return (req, res, next) => {
    const raw = req.header('x-test-claims');
    if (!raw) {
      res.status(401).json({ error: 'Missing x-test-claims' });
      return;
    }
    try {
      (req as AuthedRequest).user = JSON.parse(raw) as AuthClaims;
      next();
    } catch {
      res.status(401).json({ error: 'Bad x-test-claims' });
    }
  };
}

const aliceClaims: AuthClaims = {
  sub: 'user-alice',
  email: 'alice@example.com',
  squadIds: ['growth'],
  isCsm: false,
};

function makeProposal(overrides: Partial<ProposalSummary> = {}): ProposalSummary {
  return {
    id: 'fi-1',
    correlationId: 'corr-1',
    source: 'slack',
    sourceUrl: 'https://acme.slack.com/archives/C-feedback/p42',
    redactedText: '[EMAIL] wants CSV exports',
    proposedAt: new Date('2026-04-01T12:00:00Z'),
    proposalScore: 0.91,
    status: 'pending',
    backlogEntryId: 'be-1',
    linearId: 'lin-csv',
    backlogTitle: 'CSV exports',
    ...overrides,
  };
}

function makeRepo(): ProposalsRepository {
  return {
    list: vi.fn(),
    get: vi.fn(),
    setStatus: vi.fn(),
  };
}

function makeLinear(): LinearSync {
  return {
    mirror: vi.fn(),
    addComment: vi.fn(),
    createIssue: vi.fn(),
  };
}

/** No-op middleware that lets every request through. Keeps the default
 *  express-rate-limit out of the existing suite so we can hammer the
 *  endpoints without hitting 429. A dedicated block below exercises
 *  the real limiter. */
const noRateLimit: RequestHandler = (_req, _res, next) => next();

function startApp(
  repo: ProposalsRepository,
  linear: LinearSync,
  overrides: { writeRateLimit?: RequestHandler } = {},
): { url: string; server: Server; close: () => Promise<void> } {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/proposals',
    createProposalsRouter({
      repo,
      linear,
      authMiddleware: testAuth(),
      writeRateLimit: overrides.writeRateLimit ?? noRateLimit,
    }),
  );
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const headers = (claims: AuthClaims, extra: Record<string, string> = {}) => ({
  'x-test-claims': JSON.stringify(claims),
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/proposals', () => {
  it('returns 401 when the auth middleware rejects (no claims header)', async () => {
    const ctx = startApp(makeRepo(), makeLinear());
    try {
      const r = await fetch(`${ctx.url}/api/proposals`);
      expect(r.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it('passes the validated AuthClaims into repo.list and serialises the response', async () => {
    const repo = makeRepo();
    (repo.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([makeProposal()]);
    const ctx = startApp(repo, makeLinear());
    try {
      const r = await fetch(`${ctx.url}/api/proposals?limit=10`, {
        headers: headers(aliceClaims),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { proposals: Array<{ id: string; proposedAt: string }> };
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0]?.id).toBe('fi-1');
      expect(body.proposals[0]?.proposedAt).toBe('2026-04-01T12:00:00.000Z');

      const listMock = repo.list as ReturnType<typeof vi.fn>;
      expect(listMock.mock.calls[0]?.[0]).toEqual(aliceClaims);
      expect(listMock.mock.calls[0]?.[1]).toMatchObject({ limit: 10 });
    } finally {
      await ctx.close();
    }
  });
});

describe('GET /api/proposals/:id', () => {
  it('returns 404 when the repository returns null (ACL miss or unknown id)', async () => {
    const repo = makeRepo();
    (repo.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const ctx = startApp(repo, makeLinear());
    try {
      const r = await fetch(`${ctx.url}/api/proposals/missing`, {
        headers: headers(aliceClaims),
      });
      expect(r.status).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it('returns 200 with the serialised summary when the ACL matches', async () => {
    const repo = makeRepo();
    (repo.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeProposal());
    const ctx = startApp(repo, makeLinear());
    try {
      const r = await fetch(`${ctx.url}/api/proposals/fi-1`, { headers: headers(aliceClaims) });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { proposal: { id: string } };
      expect(body.proposal.id).toBe('fi-1');
    } finally {
      await ctx.close();
    }
  });
});

describe('POST /api/proposals/:id/approve', () => {
  it('LINK path: addComment + setStatus("approved")', async () => {
    const repo = makeRepo();
    const lin = makeLinear();
    (repo.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeProposal());
    (repo.setStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeProposal({ status: 'approved' }),
    );

    const ctx = startApp(repo, lin);
    try {
      const r = await fetch(`${ctx.url}/api/proposals/fi-1/approve`, {
        method: 'POST',
        headers: headers(aliceClaims, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(200);
      expect(lin.addComment).toHaveBeenCalledOnce();
      expect((lin.addComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
        linearIssueId: 'lin-csv',
        sourceUrl: 'https://acme.slack.com/archives/C-feedback/p42',
      });
      expect(lin.createIssue).not.toHaveBeenCalled();
      expect((repo.setStatus as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toBe('approved');
    } finally {
      await ctx.close();
    }
  });

  it('NEW path: rejects without newTitle in body', async () => {
    const repo = makeRepo();
    const lin = makeLinear();
    (repo.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeProposal({ backlogEntryId: null, linearId: null }),
    );
    const ctx = startApp(repo, lin);
    try {
      const r = await fetch(`${ctx.url}/api/proposals/fi-1/approve`, {
        method: 'POST',
        headers: headers(aliceClaims, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(400);
      expect(lin.createIssue).not.toHaveBeenCalled();
      expect(repo.setStatus).not.toHaveBeenCalled();
    } finally {
      await ctx.close();
    }
  });

  it('NEW path: createIssue when newTitle is supplied', async () => {
    const repo = makeRepo();
    const lin = makeLinear();
    (repo.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeProposal({ backlogEntryId: null, linearId: null }),
    );
    (lin.createIssue as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      linearId: 'lin-new-99',
    });
    (repo.setStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeProposal({ status: 'approved' }),
    );

    const ctx = startApp(repo, lin);
    try {
      const r = await fetch(`${ctx.url}/api/proposals/fi-1/approve`, {
        method: 'POST',
        headers: headers(aliceClaims, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ newTitle: 'Adding CSV exports' }),
      });
      expect(r.status).toBe(200);
      expect(lin.createIssue).toHaveBeenCalledOnce();
      expect((lin.createIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
        title: 'Adding CSV exports',
      });
      expect(lin.addComment).not.toHaveBeenCalled();
    } finally {
      await ctx.close();
    }
  });

  it('returns 502 (and does not flip status) when Linear fails', async () => {
    const repo = makeRepo();
    const lin = makeLinear();
    (repo.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeProposal());
    (lin.addComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Linear 503'));
    const ctx = startApp(repo, lin);
    try {
      const r = await fetch(`${ctx.url}/api/proposals/fi-1/approve`, {
        method: 'POST',
        headers: headers(aliceClaims, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(502);
      expect(repo.setStatus).not.toHaveBeenCalled();
    } finally {
      await ctx.close();
    }
  });
});

describe('POST /api/proposals/:id/(reject|defer)', () => {
  it('reject calls setStatus with "rejected" and forwards reason', async () => {
    const repo = makeRepo();
    (repo.setStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeProposal({ status: 'rejected' }),
    );
    const ctx = startApp(repo, makeLinear());
    try {
      const r = await fetch(`${ctx.url}/api/proposals/fi-1/reject`, {
        method: 'POST',
        headers: headers(aliceClaims, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ reason: 'duplicate' }),
      });
      expect(r.status).toBe(200);
      const args = (repo.setStatus as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args?.[2]).toBe('rejected');
      expect(args?.[3]).toBe('duplicate');
    } finally {
      await ctx.close();
    }
  });

  it('defer calls setStatus with "deferred"', async () => {
    const repo = makeRepo();
    (repo.setStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeProposal({ status: 'deferred' }),
    );
    const ctx = startApp(repo, makeLinear());
    try {
      const r = await fetch(`${ctx.url}/api/proposals/fi-1/defer`, {
        method: 'POST',
        headers: headers(aliceClaims, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ reason: 'next quarter' }),
      });
      expect(r.status).toBe(200);
      expect((repo.setStatus as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toBe('deferred');
    } finally {
      await ctx.close();
    }
  });

  it('returns 404 when the repository returns null', async () => {
    const repo = makeRepo();
    (repo.setStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const ctx = startApp(repo, makeLinear());
    try {
      const r = await fetch(`${ctx.url}/api/proposals/fi-x/reject`, {
        method: 'POST',
        headers: headers(aliceClaims, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(404);
    } finally {
      await ctx.close();
    }
  });
});

describe('write-route rate limiting', () => {
  /** Build a limiter with a small window so the test doesn't depend on
   *  real time; `express-rate-limit` doesn't expose a reset hook, so
   *  we rely on a fresh limiter per test. */
  async function makeLimiter(limit: number) {
    const { default: rateLimit } = await import('express-rate-limit');
    return rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => (req as AuthedRequest).user?.sub ?? 'anonymous',
      handler: (_req, res) => {
        res.status(429).json({ error: 'Too many requests' });
      },
    });
  }

  it('returns 429 after the per-user budget is exhausted, then keeps a second user unaffected', async () => {
    const repo = makeRepo();
    (repo.setStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeProposal({ status: 'rejected' }),
    );
    const ctx = startApp(repo, makeLinear(), { writeRateLimit: await makeLimiter(2) });
    try {
      const bobClaims: AuthClaims = { ...aliceClaims, sub: 'user-bob', email: 'bob@example.com' };
      const reject = (claims: AuthClaims) =>
        fetch(`${ctx.url}/api/proposals/fi-1/reject`, {
          method: 'POST',
          headers: headers(claims, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({}),
        });

      expect((await reject(aliceClaims)).status).toBe(200);
      expect((await reject(aliceClaims)).status).toBe(200);
      const third = await reject(aliceClaims);
      expect(third.status).toBe(429);
      expect(third.headers.get('ratelimit-remaining')).toBeDefined();

      // Bob is keyed independently — his first request still succeeds.
      expect((await reject(bobClaims)).status).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  it('shares the budget across approve / reject / defer for a single user', async () => {
    const repo = makeRepo();
    (repo.get as ReturnType<typeof vi.fn>).mockResolvedValue(makeProposal());
    (repo.setStatus as ReturnType<typeof vi.fn>).mockResolvedValue(makeProposal());
    const lin = makeLinear();
    (lin.addComment as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const ctx = startApp(repo, lin, { writeRateLimit: await makeLimiter(2) });
    try {
      const post = (path: string) =>
        fetch(`${ctx.url}/api/proposals/fi-1/${path}`, {
          method: 'POST',
          headers: headers(aliceClaims, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({}),
        });

      expect((await post('approve')).status).toBe(200);
      expect((await post('reject')).status).toBe(200);
      expect((await post('defer')).status).toBe(429);
    } finally {
      await ctx.close();
    }
  });

  it('does not rate-limit reads even when writes are exhausted', async () => {
    const repo = makeRepo();
    (repo.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (repo.setStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeProposal({ status: 'rejected' }),
    );
    const ctx = startApp(repo, makeLinear(), { writeRateLimit: await makeLimiter(1) });
    try {
      const post = () =>
        fetch(`${ctx.url}/api/proposals/fi-1/reject`, {
          method: 'POST',
          headers: headers(aliceClaims, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({}),
        });
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(429);

      const list = await fetch(`${ctx.url}/api/proposals`, { headers: headers(aliceClaims) });
      expect(list.status).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});
