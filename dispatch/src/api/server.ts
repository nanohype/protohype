/**
 * Dispatch API Server
 *
 *   GET  /health                          — unauthenticated
 *   GET  /drafts/:id                      — WorkOS JWT
 *   POST /drafts/:id/edits                — WorkOS JWT
 *   POST /drafts/:id/approve              — WorkOS JWT + approver allow-list
 *   POST /admin/pipeline-run              — WorkOS JWT + approver allow-list
 *   GET  /admin/pipeline-run/:taskArn     — WorkOS JWT + approver allow-list
 *
 * Every audit write awaits. SIGTERM drains in-flight requests before exit.
 * Correlation ID in X-Run-Id on every response that touches a draft.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { createAuthenticator, extractBearerToken, isApprover, unsafeDecodeClaims, type SessionClaims } from './auth.js';
import type { ApiConfig, Approvers } from './config.js';
import {
  DraftIdParamSchema,
  EditsBodySchema,
  EcsTaskArnParamSchema,
  ValidationError,
  parseOrThrow,
} from './schemas.js';
import { getLogger } from '../common/logger.js';
import { draftEditRate, emailSent } from '../common/metrics.js';
import type { Draft } from '../pipeline/types.js';
import type { PipelineTriggerPort } from './pipeline-trigger.js';

export interface NewDraftInput {
  runId: string;
  weekOf: Date;
  sections: Draft['sections'];
  fullText: string;
}

export interface DraftRepository {
  create(input: NewDraftInput): Promise<string>;
  findById(id: string): Promise<Draft | null>;
  saveEditCheckpoint(id: string, editedText: string, editorUserId: string): Promise<void>;
  approve(id: string, approverUserId: string): Promise<void>;
  markSent(id: string): Promise<void>;
  /** Most recently created draft at or after `since`. Used by /admin/pipeline-run/:taskArn
   * to correlate a finished ECS task back to the draft it produced. Returns null when
   * the task wrote no draft (e.g. crashed before phase.audit_and_notify). */
  findMostRecentSince(since: Date): Promise<{ id: string; runId: string } | null>;
}

export interface EditStats {
  distanceChars: number;
  editRate: number;
}

export interface AuditWriterPort {
  humanEdit(runId: string, draftId: string, editorUserId: string, originalText: string, editedText: string): Promise<EditStats>;
  approved(runId: string, draftId: string, approverUserId: string): Promise<void>;
  sent(runId: string, draftId: string, sesMessageId: string, recipientCount: number): Promise<void>;
}

export interface EmailSender {
  send(input: {
    draftId: string;
    subject: string;
    htmlBody: string;
    textBody: string;
  }): Promise<{ messageId: string; recipientCount: number }>;
}

export interface SlackConfirmer {
  confirmSent(runId: string, draftId: string, recipientCount: number): Promise<void>;
}

export interface ServerDeps {
  config: ApiConfig;
  draftRepository: DraftRepository;
  auditWriter: AuditWriterPort;
  emailSender: EmailSender;
  slackConfirmer: SlackConfirmer;
  /** Optional. When provided, exposes /admin/pipeline-run for ad-hoc
   * operator-driven runs. When absent, the routes 503 — useful for
   * tests + dev where no ECS cluster is reachable. */
  pipelineTrigger?: PipelineTriggerPort;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionClaims;
  }
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, draftRepository, auditWriter, emailSender, slackConfirmer, pipelineTrigger } = deps;
  // Fastify v5+: pass a pre-built Pino instance via `loggerInstance`. The
  // `logger` option only accepts a configuration object (or `true` for
  // defaults). Passing an instance to `logger` throws
  // FST_ERR_LOG_INVALID_LOGGER_CONFIG at startup.
  const app = Fastify({
    loggerInstance: getLogger(),
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  });
  const authenticator = createAuthenticator({ issuer: config.env.WORKOS_ISSUER, clientId: config.env.WORKOS_CLIENT_ID });

  await app.register(cors, {
    origin: config.env.WEB_ORIGIN,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
    maxAge: 600,
  });

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health') return;
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      reply.code(401).send({ error: 'Missing authorization token' });
      return reply;
    }
    try {
      req.user = await authenticator.verify(token);
    } catch (err) {
      // Surface why verify failed — bare catch made every JWT failure
      // indistinguishable in logs (signature wrong vs expired vs wrong
      // issuer all looked the same). Token claims have no secrets, so
      // logging them speeds up future diagnosis.
      const claims = unsafeDecodeClaims(token);
      req.log.warn(
        {
          err,
          tokenClaims: claims
            ? { sub: claims.sub, aud: claims.aud, iss: claims.iss, exp: claims.exp }
            : null,
        },
        'auth.verify-failed',
      );
      reply.code(401).send({ error: 'Invalid or expired token' });
      return reply;
    }
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ValidationError) {
      reply.code(400).send({ error: 'ValidationError', issues: error.issues });
      return;
    }
    app.log.error(error);
    reply.code(500).send({ error: 'InternalServerError' });
  });

  app.get('/drafts/:id', async (req, reply) => {
    const { id } = parseOrThrow(DraftIdParamSchema, req.params);
    const draft = await draftRepository.findById(id);
    if (!draft) return reply.code(404).send({ error: 'Draft not found' });
    return replyWithDraft(reply, draft);
  });

  app.post('/drafts/:id/edits', async (req, reply) => {
    const { id } = parseOrThrow(DraftIdParamSchema, req.params);
    const { editedText } = parseOrThrow(EditsBodySchema, req.body);
    const user = requireUser(req);

    const draft = await draftRepository.findById(id);
    if (!draft) return reply.code(404).send({ error: 'Draft not found' });
    if (draft.status !== 'PENDING') return reply.code(409).send({ error: `Draft is ${draft.status}` });

    const stats = await auditWriter.humanEdit(draft.runId, draft.id, user.sub, draft.fullText, editedText);
    draftEditRate.record(stats.editRate, { run_id: draft.runId });
    await draftRepository.saveEditCheckpoint(draft.id, editedText, user.sub);
    reply.header('X-Run-Id', draft.runId).send({ status: 'saved' });
  });

  app.post('/drafts/:id/approve', async (req, reply) => {
    const { id } = parseOrThrow(DraftIdParamSchema, req.params);
    const user = requireUser(req);

    const approvers = await config.loadApprovers();
    if (!isApprover(user, approvers)) {
      return reply.code(403).send({ error: 'Only CoS or designated backups can approve' });
    }

    const draft = await draftRepository.findById(id);
    if (!draft) return reply.code(404).send({ error: 'Draft not found' });
    if (draft.status !== 'PENDING') return reply.code(409).send({ error: `Draft is ${draft.status}` });

    await draftRepository.approve(draft.id, user.sub);
    await auditWriter.approved(draft.runId, draft.id, user.sub);

    const sesResult = await emailSender.send({
      draftId: draft.id,
      subject: `Company Update — Week of ${formatWeekOf(draft.weekOf)}`,
      htmlBody: renderHtml(draft.fullText),
      textBody: draft.fullText,
    });

    await auditWriter.sent(draft.runId, draft.id, sesResult.messageId, sesResult.recipientCount);
    emailSent.add(sesResult.recipientCount, { run_id: draft.runId });
    await draftRepository.markSent(draft.id);
    await slackConfirmer.confirmSent(draft.runId, draft.id, sesResult.recipientCount);

    reply
      .header('X-Run-Id', draft.runId)
      .send({ status: 'sent', sesMessageId: sesResult.messageId, recipientCount: sesResult.recipientCount });
  });

  // Ad-hoc pipeline trigger. Same approver gate as POST /approve — only
  // accounts that can send the newsletter can also fire a draft-generating
  // run. The route is a thin wrapper around an injected port so tests don't
  // need ECS reachability and the API process doesn't depend on AWS being
  // up just to pass health checks.
  app.post('/admin/pipeline-run', async (req, reply) => {
    const user = requireUser(req);
    const approvers = await config.loadApprovers();
    if (!isApprover(user, approvers)) {
      return reply.code(403).send({ error: 'Only CoS or designated backups can trigger pipeline runs' });
    }
    if (!pipelineTrigger) {
      return reply.code(503).send({ error: 'Pipeline trigger not configured in this environment' });
    }
    const result = await pipelineTrigger.trigger();
    getLogger().info({ user: user.sub, ecsTaskArn: result.ecsTaskArn }, 'admin.pipeline-run.triggered');
    reply.send(result);
  });

  // Wildcard route. ECS task ARNs contain slashes (`task/<cluster>/<id>`),
  // and a Fastify `:taskArn` parameter only matches a single path segment.
  // URL-encoding `%2F` doesn't help — Fastify decodes before routing.
  // Wildcard `*` captures the full remaining path.
  app.get('/admin/pipeline-run/*', async (req, reply) => {
    const user = requireUser(req);
    const approvers = await config.loadApprovers();
    if (!isApprover(user, approvers)) {
      return reply.code(403).send({ error: 'Only CoS or designated backups can view pipeline status' });
    }
    if (!pipelineTrigger) {
      return reply.code(503).send({ error: 'Pipeline trigger not configured in this environment' });
    }
    const wildcardParam = (req.params as { '*'?: string })['*'] ?? '';
    const { taskArn } = parseOrThrow(EcsTaskArnParamSchema, { taskArn: wildcardParam });
    const status = await pipelineTrigger.status(taskArn);
    if (status.state !== 'completed') {
      return reply.send(status);
    }
    // Pipeline finished — try to correlate to the draft it just wrote.
    // Search from the task's start time so we don't surface stale drafts
    // from earlier runs. Null result means the pipeline crashed before
    // writing a draft (still rare; would surface in audit_events as
    // PIPELINE_FAILURE without a corresponding DRAFT_GENERATED).
    const draft = await draftRepository.findMostRecentSince(new Date(status.startedAt));
    reply.send({ ...status, draftId: draft?.id, runId: draft?.runId });
  });

  // Cast: Fastify's `loggerInstance` option types the instance with Pino's
  // `Logger` (which has `msgPrefix`), while `FastifyInstance`'s default
  // generic uses `FastifyBaseLogger` (which doesn't). The two are call-
  // compatible at runtime; the cast bridges the type-system mismatch.
  return app as unknown as FastifyInstance;
}

function requireUser(req: FastifyRequest): SessionClaims {
  if (!req.user) throw new Error('Unauthenticated request reached handler');
  return req.user;
}

function replyWithDraft(reply: FastifyReply, draft: Draft) {
  reply.header('X-Run-Id', draft.runId).send({
    id: draft.id,
    weekOf: draft.weekOf,
    status: draft.status,
    sections: draft.sections,
    fullText: draft.fullText,
    createdAt: draft.createdAt,
  });
}

function formatWeekOf(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function renderHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;"><pre style="white-space:pre-wrap;font-family:inherit;">${escaped}</pre></body></html>`;
}

export function registerShutdownHandlers(app: FastifyInstance): void {
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Received shutdown signal, draining connections');
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'Error during Fastify close');
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

export type { Approvers };
