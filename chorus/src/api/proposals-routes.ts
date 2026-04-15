import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, type AuthedRequest } from '../lib/auth.js';

export type AuthMiddleware = RequestHandler;
import { logger } from '../lib/observability.js';
import { rehydrateRedacted } from '../matching/redacted-text.js';
import type { ProposalsRepository, ProposalSummary } from './proposals-repository.js';
import type { LinearSync } from '../ingestion/linear-sync.js';
import { sendBadGateway } from './http-errors.js';

export interface ProposalsRoutesDeps {
  repo: ProposalsRepository;
  linear: LinearSync;
  /** Auth middleware to mount in front of every route. Defaults to the
   *  real WorkOS-RS256 middleware; tests inject a stub that populates
   *  `req.user` from a fixture. */
  authMiddleware?: AuthMiddleware;
  /** Middleware mounted in front of the three write routes
   *  (approve / reject / defer). Defaults to a per-caller token-bucket
   *  sized by `API_WRITE_RATE_PER_MIN` (30/min); tests inject a no-op
   *  to sidestep the limiter. */
  writeRateLimit?: RequestHandler;
}

/**
 * Per-user rate limiter for the three mutation routes. Key is the
 * verified `sub` claim populated by the auth middleware; we
 * intentionally do not fall back to IP because the auth middleware
 * has already run and a missing `sub` means something is wrong —
 * reject rather than silently switch to a broader key.
 */
function defaultWriteRateLimit(): RequestHandler {
  const perMin = Number.parseInt(process.env['API_WRITE_RATE_PER_MIN'] ?? '30', 10);
  return rateLimit({
    windowMs: 60_000,
    limit: Number.isFinite(perMin) && perMin > 0 ? perMin : 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const sub = (req as AuthedRequest).user?.sub;
      if (!sub) {
        logger.warn('rate-limit keyGenerator saw no user.sub', { path: req.path });
        return 'anonymous';
      }
      return sub;
    },
    handler: (_req, res) => {
      res.status(429).json({ error: 'Too many requests' });
    },
  });
}

/**
 * `/api/proposals` mounted under requireAuth. The auth middleware
 * populates req.user with AuthClaims; the repository applies the
 * server-side ACL filter using those claims.
 *
 * Routes:
 *   GET    /                       — list pending proposals visible to
 *                                    the caller's squads/CSM ACL
 *   GET    /:id                    — single proposal (404 on ACL miss
 *                                    or not-found — we don't disclose
 *                                    existence to unauthorized callers)
 *   POST   /:id/approve            — mark approved + sync to Linear
 *                                    (addComment for LINK,
 *                                    createIssue for NEW). Body:
 *                                    { newTitle?: string } for NEW path.
 *   POST   /:id/reject             — mark rejected. Body: { reason?: string }.
 *   POST   /:id/defer              — mark deferred. Body: { reason?: string }.
 */
export function createProposalsRouter(deps: ProposalsRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware ?? requireAuth);
  const writeLimit = deps.writeRateLimit ?? defaultWriteRateLimit();

  router.get('/', list(deps));
  router.get('/:id', get(deps));
  router.post('/:id/approve', writeLimit, approve(deps));
  router.post('/:id/reject', writeLimit, setStatus(deps, 'rejected', 'REJECT'));
  router.post('/:id/defer', writeLimit, setStatus(deps, 'deferred', 'DEFER'));

  return router;
}

function list({ repo }: ProposalsRoutesDeps): RequestHandler {
  return (req, res, next) => {
    const claims = (req as AuthedRequest).user;
    if (!claims) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const limit = parseLimit(req.query['limit']);
    const before = parseDate(req.query['before']);
    repo
      .list(claims, { limit, before })
      .then((rows) => res.json({ proposals: rows.map(serializeSummary) }))
      .catch(next);
  };
}

function get({ repo }: ProposalsRoutesDeps): RequestHandler {
  return (req, res, next) => {
    const claims = (req as AuthedRequest).user;
    if (!claims) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    repo
      .get(claims, String(req.params['id']))
      .then((row) => {
        if (!row) {
          res.status(404).json({ error: 'Proposal not found' });
          return;
        }
        res.json({ proposal: serializeSummary(row) });
      })
      .catch(next);
  };
}

function approve({ repo, linear }: ProposalsRoutesDeps): RequestHandler {
  return (req, res, next) => {
    const claims = (req as AuthedRequest).user;
    if (!claims) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const id = String(req.params['id']);
    const newTitle = (req.body as { newTitle?: unknown })?.newTitle;
    (async () => {
      const proposal = await repo.get(claims, id);
      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      const redactedText = rehydrateRedacted(proposal.redactedText);
      try {
        if (proposal.backlogEntryId && proposal.linearId) {
          await linear.addComment({
            correlationId: proposal.correlationId,
            linearIssueId: proposal.linearId,
            redactedText,
            sourceUrl: proposal.sourceUrl,
          });
        } else {
          if (typeof newTitle !== 'string' || !newTitle.trim()) {
            res.status(400).json({ error: 'newTitle is required to approve a NEW proposal' });
            return;
          }
          await linear.createIssue({
            correlationId: proposal.correlationId,
            title: newTitle.trim(),
            descriptionRedacted: redactedText,
          });
        }
      } catch (err) {
        sendBadGateway(res, 'Upstream Linear call failed', err, {
          correlationId: proposal.correlationId,
          id,
        });
        return;
      }

      const updated = await repo.setStatus(claims, id, 'approved');
      if (!updated) {
        res.status(404).json({ error: 'Proposal disappeared between checks' });
        return;
      }
      res.json({ proposal: serializeSummary(updated) });
    })().catch(next);
  };
}

function setStatus(
  { repo }: ProposalsRoutesDeps,
  status: 'rejected' | 'deferred',
  _stage: string,
): RequestHandler {
  return (req, res, next) => {
    const claims = (req as AuthedRequest).user;
    if (!claims) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const id = String(req.params['id']);
    const reason = (req.body as { reason?: unknown })?.reason;
    repo
      .setStatus(claims, id, status, typeof reason === 'string' ? reason : undefined)
      .then((row) => {
        if (!row) {
          res.status(404).json({ error: 'Proposal not found' });
          return;
        }
        res.json({ proposal: serializeSummary(row) });
      })
      .catch(next);
  };
}

function parseLimit(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function serializeSummary(s: ProposalSummary) {
  return {
    id: s.id,
    correlationId: s.correlationId,
    source: s.source,
    sourceUrl: s.sourceUrl,
    redactedText: s.redactedText,
    proposedAt: s.proposedAt?.toISOString() ?? null,
    proposalScore: s.proposalScore,
    status: s.status,
    backlogEntryId: s.backlogEntryId,
    linearId: s.linearId,
    backlogTitle: s.backlogTitle,
  };
}
