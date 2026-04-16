import { createExternalClient } from './http.js';
import { getSecretString } from './secrets.js';
import { logger } from './observability.js';

export interface SlackClient {
  postMessage(p: { channel: string; text: string; correlationId?: string }): Promise<void>;
  sendDm(p: { userId: string; text: string; correlationId?: string }): Promise<void>;
}

export interface CreateSlackClientDeps {
  /** Async accessor for the bot OAuth token; defaults to Secrets
   *  Manager (chorus/slack/bot-token). */
  getApiToken?: () => Promise<string>;
  /** Inject the fetch implementation; defaults to native fetch. Tests
   *  pass `vi.fn<typeof fetch>(...)` and assert on URL + body. */
  fetchImpl?: typeof fetch;
}

export function createSlackClient(deps: CreateSlackClientDeps = {}): SlackClient {
  const getApiToken = deps.getApiToken ?? (() => getSecretString('chorus/slack/bot-token'));
  const fetchImpl = deps.fetchImpl;

  async function http() {
    const token = await getApiToken();
    return createExternalClient({
      baseUrl: 'https://slack.com',
      headers: { Authorization: `Bearer ${token}` },
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  return {
    async postMessage({ channel, text, correlationId }) {
      const client = await http();
      const r = await client.request<{ ok: boolean; error?: string }>({
        method: 'POST',
        path: '/api/chat.postMessage',
        body: { channel, text, unfurl_links: false },
        correlationId,
      });
      if (!r.ok) throw new Error(`Slack postMessage failed: ${r.error}`);
      logger.info('Slack message posted', { channel });
    },
    async sendDm({ userId, text, correlationId }) {
      const client = await http();
      const open = await client.request<{ ok: boolean; channel?: { id: string }; error?: string }>({
        method: 'POST',
        path: '/api/conversations.open',
        body: { users: userId },
        correlationId,
      });
      if (!open.ok || !open.channel) {
        logger.warn('Could not open DM', { userId });
        return;
      }
      await client.request({
        method: 'POST',
        path: '/api/chat.postMessage',
        body: { channel: open.channel.id, text, unfurl_links: false },
        correlationId,
      });
    },
  };
}

let _default: SlackClient | undefined;
export function getSlackClient(): SlackClient {
  if (!_default) _default = createSlackClient();
  return _default;
}
