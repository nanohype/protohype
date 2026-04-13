/**
 * Slack Events Route
 *
 * Hot path: verify signature → ack 200 immediately → process async
 * (Slack requires HTTP 200 within 3s; heavy work happens after the ack)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { resolveOktaUserId } from '../services/identity.js';
import { TokenStore } from '../services/token-store.js';
import { RateLimiter } from '../services/rate-limit.js';
import { AuditLogger } from '../services/audit.js';
import { AlmanacPipeline } from '@almanac/ai';
import type { ConnectorName, OAuthToken } from '@almanac/ai';

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET!;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const ONBOARDING_PROVIDERS: ConnectorName[] = ['notion', 'confluence', 'gdrive'];

function verifySlackSignature(body: string, timestamp: string, signature: string): boolean {
  const baseStr = `v0:${timestamp}:${body}`;
  const expected = 'v0=' + createHmac('sha256', SLACK_SIGNING_SECRET).update(baseStr).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function slackRoutes(
  fastify: FastifyInstance,
  opts: { tokenStore: TokenStore; rateLimiter: RateLimiter; auditLogger: AuditLogger; pipeline: AlmanacPipeline; baseUrl: string },
): Promise<void> {
  fastify.post('/slack/events', { config: { rawBody: true } }, async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const timestamp = req.headers['x-slack-request-timestamp'] as string;
    const signature = req.headers['x-slack-signature'] as string;

    if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300)
      return reply.status(403).send({ error: 'Request too old' });
    if (!verifySlackSignature(rawBody, timestamp, signature))
      return reply.status(403).send({ error: 'Invalid signature' });

    const body = req.body as SlackEventBody;
    if (body.type === 'url_verification') return reply.send({ challenge: body.challenge });

    reply.status(200).send();
    processEvent(body, opts).catch(err => fastify.log.error({ err }, 'Error processing Slack event'));
  });
}

async function processEvent(body: SlackEventBody, opts: { tokenStore: TokenStore; rateLimiter: RateLimiter; auditLogger: AuditLogger; pipeline: AlmanacPipeline; baseUrl: string }): Promise<void> {
  const event = body.event;
  if (!event) return;
  const isAppMention = event.type === 'app_mention';
  const isDM = event.type === 'message' && event.channel_type === 'im';
  if (!isAppMention && !isDM) return;
  if (event.bot_id) return;

  const { user: slackUserId, channel: channelId, text } = event;
  const question = stripBotMention(text ?? '');

  if (!question.trim()) { await sendSlackMessage(channelId, HELP_MESSAGE); return; }
  if (question.trim().toLowerCase() === 'help') { await sendOnboardingDM(slackUserId, opts.baseUrl, opts.tokenStore); return; }

  let oktaUserId: string;
  try { oktaUserId = await resolveOktaUserId(slackUserId); }
  catch { await sendSlackMessage(channelId, "⚠️ I couldn't verify your identity. Please contact IT to ensure your Slack account is linked in Okta."); return; }

  const rateResult = await opts.rateLimiter.check(slackUserId);
  if (!rateResult.allowed) { await sendSlackMessage(channelId, "You've sent a lot of questions quickly. Please wait a moment before asking again."); return; }

  const storedTokens = await opts.tokenStore.getAllForUser(slackUserId);
  if (Object.keys(storedTokens).length === 0) {
    await sendOnboardingDM(slackUserId, opts.baseUrl, opts.tokenStore);
    await sendSlackMessage(channelId, "I've sent you a DM to connect your knowledge sources. Once connected, ask me anything!");
    return;
  }

  const userTokens: Partial<Record<ConnectorName, OAuthToken>> = {};
  for (const [provider, stored] of Object.entries(storedTokens)) {
    userTokens[provider as ConnectorName] = { accessToken: stored.accessToken, refreshToken: stored.refreshToken, expiresAt: new Date(stored.expiresAt), provider: provider as ConnectorName, userId: slackUserId };
  }

  const { answer, slackBlocks } = await opts.pipeline.run({ question, slackUserId, userTokens });
  await sendSlackBlocks(channelId, slackBlocks as SlackBlocks);

  void opts.auditLogger.log({ slackUserId, oktaUserId, question, retrievedDocIds: answer.citations.map(c => c.docId), answerText: answer.text, connectorStatuses: answer.connectorStatuses as Record<string, string>, latencyMs: answer.latencyMs });
}

async function sendSlackMessage(channel: string, text: string): Promise<void> {
  await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, text }) });
}

async function sendSlackBlocks(channel: string, blocks: SlackBlocks): Promise<void> {
  await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, ...blocks }) });
}

async function sendOnboardingDM(slackUserId: string, baseUrl: string, tokenStore: TokenStore): Promise<void> {
  const storedTokens = await tokenStore.getAllForUser(slackUserId);
  const missing = ONBOARDING_PROVIDERS.filter(p => !storedTokens[p]);
  if (missing.length === 0) return;
  const onboardingBlocks = {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: "👋 Hi! I'm *Almanac*, NanoCorp's internal knowledge bot.\nTo answer your questions, I need to connect to your accounts:" } },
      ...missing.map(provider => ({ type: 'section', text: { type: 'mrkdwn', text: `• *${capitalize(provider)}*` }, accessory: { type: 'button', text: { type: 'plain_text', text: `Connect ${capitalize(provider)}` }, url: `${baseUrl}/oauth/connect/${provider}?slack_user_id=${slackUserId}`, action_id: `connect_${provider}` } })),
      { type: 'context', elements: [{ type: 'mrkdwn', text: "Connect one or all — Almanac will use whatever's available." }] },
    ],
  };
  const dmResponse = await fetch('https://slack.com/api/conversations.open', { method: 'POST', headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ users: slackUserId }) });
  const dm = await dmResponse.json() as { channel: { id: string } };
  await sendSlackBlocks(dm.channel.id, onboardingBlocks as SlackBlocks);
}

function stripBotMention(text: string): string { return text.replace(/<@[A-Z0-9]+>/g, '').trim(); }
function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
const HELP_MESSAGE = "*Almanac* answers questions grounded in Notion, Confluence, and Google Drive.\nUsage: `@almanac [your question]`\nTo connect your accounts: `@almanac help`";
interface SlackEventBody { type: string; challenge?: string; event?: { type: string; user: string; text: string; channel: string; channel_type?: string; bot_id?: string; }; }
interface SlackBlocks { blocks: object[]; }
