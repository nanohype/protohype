/**
 * OAuth Routes — /oauth/connect/:provider and /oauth/callback/:provider
 * PKCE state stored in Redis (10-min TTL) to prevent CSRF
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'crypto';
import type { RedisClientType } from 'redis';
import { TokenStore } from '../services/token-store.js';

const PROVIDER_CONFIG = {
  notion: { authUrl: 'https://api.notion.com/v1/oauth/authorize', tokenUrl: 'https://api.notion.com/v1/oauth/token', clientId: process.env.NOTION_CLIENT_ID!, clientSecret: process.env.NOTION_CLIENT_SECRET!, scopes: 'read_content' },
  confluence: { authUrl: 'https://auth.atlassian.com/authorize', tokenUrl: 'https://auth.atlassian.com/oauth/token', clientId: process.env.CONFLUENCE_CLIENT_ID!, clientSecret: process.env.CONFLUENCE_CLIENT_SECRET!, scopes: 'read:confluence-content.all read:confluence-space.summary offline_access' },
  gdrive: { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET!, scopes: 'https://www.googleapis.com/auth/drive.readonly' },
} as const;

type Provider = keyof typeof PROVIDER_CONFIG;

export async function oauthRoutes(
  fastify: FastifyInstance,
  opts: { redis: RedisClientType; tokenStore: TokenStore; baseUrl: string },
): Promise<void> {
  fastify.get('/oauth/connect/:provider', async (req: FastifyRequest, reply: FastifyReply) => {
    const { provider } = req.params as { provider: string };
    const { slack_user_id } = req.query as { slack_user_id: string };
    if (!isValidProvider(provider)) return reply.status(400).send({ error: `Unknown provider: ${provider}` });
    if (!slack_user_id) return reply.status(400).send({ error: 'Missing slack_user_id' });

    const state = randomBytes(32).toString('hex');
    await opts.redis.setEx(`oauth:state:${state}`, 600, slack_user_id);

    const config = PROVIDER_CONFIG[provider];
    const redirectUri = `${opts.baseUrl}/oauth/callback/${provider}`;
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: config.scopes, state, ...(provider === 'gdrive' ? { access_type: 'offline', prompt: 'consent' } : {}), ...(provider === 'confluence' ? { audience: 'api.atlassian.com', prompt: 'consent' } : {}) });
    return reply.redirect(`${config.authUrl}?${params.toString()}`);
  });

  fastify.get('/oauth/callback/:provider', async (req: FastifyRequest, reply: FastifyReply) => {
    const { provider } = req.params as { provider: string };
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

    if (error) return reply.send('<html><body><h2>Connection cancelled.</h2><p>Close this tab and try again in Slack.</p></body></html>');
    if (!isValidProvider(provider) || !code || !state) return reply.status(400).send({ error: 'Invalid callback parameters' });

    const slackUserId = await opts.redis.get(`oauth:state:${state}`);
    if (!slackUserId) return reply.status(403).send({ error: 'Invalid or expired state' });
    await opts.redis.del(`oauth:state:${state}`);

    const config = PROVIDER_CONFIG[provider];
    const tokenResponse = await fetch(config.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: `${opts.baseUrl}/oauth/callback/${provider}`, client_id: config.clientId, client_secret: config.clientSecret }) });
    if (!tokenResponse.ok) { fastify.log.error({ provider, status: tokenResponse.status }, 'Token exchange failed'); return reply.status(500).send({ error: 'Token exchange failed' }); }

    const tokens = await tokenResponse.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + (tokens.expires_in ?? 3600) * 1000);

    await opts.tokenStore.put({ slackUserId, provider, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? '', expiresAt: expiresAt.toISOString(), issuedAt: issuedAt.toISOString() });
    fastify.log.info({ provider, slackUserId }, 'OAuth token stored');
    return reply.send(`<html><body><h2>✅ ${capitalize(provider)} connected!</h2><p>Close this tab and return to Slack.</p></body></html>`);
  });
}

function isValidProvider(p: string): p is Provider { return p in PROVIDER_CONFIG; }
function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
