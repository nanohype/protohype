import crypto from 'node:crypto';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { logger } from '../lib/observability.js';
import { getSecretString } from '../lib/secrets.js';
import { processFeedbackItem, type PipelineDeps } from '../ingestion/pipeline.js';
import type { RawFeedbackItem } from '../ingestion/types.js';
import { sendBadGateway } from './http-errors.js';

export interface IngestRoutesDeps {
  pipelineDeps: PipelineDeps;
  getSlackSigningSecret?: () => Promise<string>;
  getIngestApiKey?: () => Promise<string>;
  channelToSquad?: (channelId: string) => string | undefined;
}

const FIVE_MINUTES_S = 5 * 60;

function parseChannelMapping(raw: string | undefined): (channelId: string) => string | undefined {
  if (!raw) return () => undefined;
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (k && v) map.set(k, v);
  }
  return (id) => map.get(id);
}

function timingSafeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function createIngestRouter(deps: IngestRoutesDeps): Router {
  const router = Router();
  const getSigningSecret =
    deps.getSlackSigningSecret ?? (() => getSecretString('chorus/slack/signing-secret'));
  const getApiKey = deps.getIngestApiKey ?? (() => getSecretString('chorus/ingest/api-key'));
  const channelToSquad =
    deps.channelToSquad ?? parseChannelMapping(process.env['SLACK_FEEDBACK_CHANNELS']);

  router.post(
    '/slack/events',
    slackRawBody(),
    slackEvents({ pipelineDeps: deps.pipelineDeps, getSigningSecret, channelToSquad }),
  );
  router.post('/api/ingest', webhookIngest({ pipelineDeps: deps.pipelineDeps, getApiKey }));

  return router;
}

function slackRawBody(): RequestHandler {
  return (req: Request, _res: Response, next) => {
    if (req.headers['content-type']?.includes('application/json') && !req.body) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        (req as Request & { rawBody: Buffer }).rawBody = Buffer.concat(chunks);
        req.body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
        next();
      });
      return;
    }
    next();
  };
}

interface SlackEventsDeps {
  pipelineDeps: PipelineDeps;
  getSigningSecret: () => Promise<string>;
  channelToSquad: (channelId: string) => string | undefined;
}

function slackEvents(sdeps: SlackEventsDeps): RequestHandler {
  return (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;

    if (body['type'] === 'url_verification') {
      res.json({ challenge: body['challenge'] });
      return;
    }

    res.status(200).send();

    // Ack has already been sent; any failure from here on must be captured
    // out-of-band so the process doesn't crash on an unhandled rejection,
    // and so the operator has a DLQ breadcrumb even when setup (signature
    // verification, secrets fetch) throws before processFeedbackItem can
    // DLQ itself.
    processSlackAsync(req, body, sdeps).catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('slack event processing crashed', { error });
      Promise.resolve(
        sdeps.pipelineDeps.dlq.sendMessage({
          correlationId: 'slack-setup-failure',
          stage: 'INGEST',
          source: 'slack',
          error,
          timestamp: new Date().toISOString(),
        }),
      ).catch((dlqErr: unknown) => {
        logger.error('dlq send failed in slack handler', {
          error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
        });
      });
    });
  };
}

async function processSlackAsync(
  req: Request,
  body: Record<string, unknown>,
  sdeps: SlackEventsDeps,
): Promise<void> {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (rawBody) {
    const ts = req.headers['x-slack-request-timestamp'] as string | undefined;
    const sig = req.headers['x-slack-signature'] as string | undefined;
    if (!ts || !sig) {
      logger.warn('slack event missing signature headers');
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(ts)) > FIVE_MINUTES_S) {
      logger.warn('slack event stale timestamp');
      return;
    }
    const secret = await sdeps.getSigningSecret();
    const basestring = `v0:${ts}:${rawBody.toString()}`;
    const expected = `v0=${crypto.createHmac('sha256', secret).update(basestring).digest('hex')}`;
    if (!timingSafeEquals(expected, sig)) {
      logger.warn('slack event signature mismatch');
      return;
    }
  }

  if (body['type'] !== 'event_callback') return;
  const event = body['event'] as Record<string, unknown> | undefined;
  if (!event || event['type'] !== 'message') return;
  if (event['subtype'] || event['bot_id']) return;

  const channel = event['channel'] as string;
  const squad = sdeps.channelToSquad(channel);
  if (!squad) return;

  const item: RawFeedbackItem = {
    source: 'slack',
    sourceItemId: `${channel}:${event['ts'] as string}`,
    sourceUrl: undefined,
    verbatimText: (event['text'] as string) ?? '',
    aclSquadIds: [squad],
  };

  await processFeedbackItem(item, sdeps.pipelineDeps);
}

interface WebhookBody {
  sourceItemId?: unknown;
  sourceUrl?: unknown;
  text?: unknown;
  aclSquadIds?: unknown;
  metadata?: unknown;
}

interface WebhookDeps {
  pipelineDeps: PipelineDeps;
  getApiKey: () => Promise<string>;
}

function webhookIngest(wdeps: WebhookDeps): RequestHandler {
  return (req: Request, res: Response) => {
    void (async () => {
      try {
        const auth = req.headers['authorization'];
        const token =
          typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        if (!token) {
          res.status(401).json({ error: 'Missing Authorization header' });
          return;
        }
        const expected = await wdeps.getApiKey();
        if (!timingSafeEquals(token, expected)) {
          res.status(401).json({ error: 'Invalid API key' });
          return;
        }

        const body = req.body as WebhookBody;
        if (typeof body.text !== 'string' || !body.text.trim()) {
          res.status(400).json({ error: 'text is required' });
          return;
        }
        if (typeof body.sourceItemId !== 'string' || !body.sourceItemId.trim()) {
          res.status(400).json({ error: 'sourceItemId is required' });
          return;
        }

        const item: RawFeedbackItem = {
          source: 'webhook',
          sourceItemId: body.sourceItemId,
          sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : undefined,
          verbatimText: body.text,
          aclSquadIds: Array.isArray(body.aclSquadIds) ? (body.aclSquadIds as string[]) : undefined,
          metadata:
            typeof body.metadata === 'object' && body.metadata !== null
              ? (body.metadata as Record<string, unknown>)
              : undefined,
        };

        const result = await processFeedbackItem(item, wdeps.pipelineDeps);
        res.json({ status: 'accepted', correlationId: result.correlationId });
      } catch (err) {
        sendBadGateway(res, 'Pipeline processing failed', err);
      }
    })();
  };
}
