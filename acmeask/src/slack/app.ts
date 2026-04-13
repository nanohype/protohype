/**
 * Slack Bolt app — registers event handlers for messages and actions.
 * Entry point for all Slack interactions.
 */
import { App } from '@slack/bolt';
import { config } from '../config';
import { logger } from '../middleware/logger';
import { runAskPipeline } from '../ai/pipeline';
import { resolveOktaUserId } from '../auth/okta';
import { getUserTokens } from '../auth/token-store';
import { checkRateLimit } from '../middleware/rate-limiter';
import {
  formatAskResponse,
  formatConnectMessage,
  formatRateLimitMessage,
  formatStaleWarning,
} from './formatter';
import {
  getNotionAuthUrl,
  getConfluenceAuthUrl,
  getGoogleAuthUrl,
  createOAuthState,
} from '../auth/oauth-flow';

export const slackApp = new App({
  token: config.SLACK_BOT_TOKEN,
  appToken: config.SLACK_APP_TOKEN,
  socketMode: true,
  signingSecret: config.SLACK_SIGNING_SECRET,
});

// Handle DMs and @mentions
slackApp.event('message', async ({ event, client, say }) => {
  if (event.type !== 'message') return;
  const msgEvent = event as typeof event & { text?: string; user?: string; thread_ts?: string };
  if (!msgEvent.text || !msgEvent.user) return;

  // Ignore bot messages
  if ('bot_id' in event) return;

  await handleQuestion(msgEvent.user, msgEvent.text, say, client, msgEvent.thread_ts);
});

slackApp.event('app_mention', async ({ event, say }) => {
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) {
    await say({ text: 'Hi! Ask me anything about Acme knowledge. For example: "What is our deployment process?"' });
    return;
  }
  await handleQuestion(event.user, text, say, undefined, event.thread_ts);
});

// OAuth connector buttons
slackApp.action('connect_notion', async ({ ack, body, client }) => {
  await ack();
  const slackUserId = body.user.id;
  const oktaUserId = await resolveOktaUserId(slackUserId);
  const state = createOAuthState(oktaUserId, slackUserId);
  const authUrl = getNotionAuthUrl(state);
  await client.chat.postEphemeral({
    channel: body.channel?.id ?? slackUserId,
    user: slackUserId,
    text: `<${authUrl}|Click here to connect Notion>`,
  });
});

slackApp.action('connect_confluence', async ({ ack, body, client }) => {
  await ack();
  const slackUserId = body.user.id;
  const oktaUserId = await resolveOktaUserId(slackUserId);
  const state = createOAuthState(oktaUserId, slackUserId);
  const authUrl = getConfluenceAuthUrl(state);
  await client.chat.postEphemeral({
    channel: body.channel?.id ?? slackUserId,
    user: slackUserId,
    text: `<${authUrl}|Click here to connect Confluence>`,
  });
});

slackApp.action('connect_google_drive', async ({ ack, body, client }) => {
  await ack();
  const slackUserId = body.user.id;
  const oktaUserId = await resolveOktaUserId(slackUserId);
  const state = createOAuthState(oktaUserId, slackUserId);
  const authUrl = getGoogleAuthUrl(state);
  await client.chat.postEphemeral({
    channel: body.channel?.id ?? slackUserId,
    user: slackUserId,
    text: `<${authUrl}|Click here to connect Google Drive>`,
  });
});

async function handleQuestion(
  slackUserId: string,
  question: string,
  say: (msg: object) => Promise<unknown>,
  client?: unknown,
  threadTs?: string
) {
  try {
    // 1. Resolve Okta identity
    const oktaUserId = await resolveOktaUserId(slackUserId);

    // 2. Check rate limit
    const { allowed } = checkRateLimit(oktaUserId);
    if (!allowed) {
      await say({
        blocks: formatRateLimitMessage(),
        text: 'Rate limit reached.',
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    // 3. Check if user has any connectors authorized
    const tokens = await getUserTokens(oktaUserId);
    const connectedConnectors = [
      tokens?.notionToken ? 'Notion' : null,
      tokens?.confluenceToken ? 'Confluence' : null,
      tokens?.googleDriveToken ? 'Google Drive' : null,
    ].filter(Boolean) as string[];

    if (connectedConnectors.length === 0) {
      await say({
        blocks: formatConnectMessage(connectedConnectors),
        text: 'Please connect your knowledge sources first.',
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    // 4. Run RAG pipeline
    const result = await runAskPipeline(slackUserId, oktaUserId, question);

    // 5. Stale warning in answer if needed
    const staleCount = result.sources.filter((s) => s.isStale).length;
    const staleText = staleCount > 0 ? `\n\n${formatStaleWarning(staleCount)}` : '';
    const answerWithWarning = result.answer + staleText;
    const modifiedResult = { ...result, answer: answerWithWarning };

    // 6. Send response
    await say({
      blocks: formatAskResponse(modifiedResult),
      text: result.answer, // fallback for notifications
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (err) {
    logger.error({ err, slackUserId }, 'Error handling question');
    await say({
      text: 'AcmeAsk encountered an error. Please try again in a few minutes.',
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }
}
