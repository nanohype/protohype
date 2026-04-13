/**
 * OAuth flow handlers — generates authorization URLs and handles callbacks
 * for Notion, Confluence, and Google Drive connector authorization.
 */
import { google } from 'googleapis';
import axios from 'axios';
import { config } from '../config';
import { storeUserTokens, getUserTokens } from './token-store';
import type { UserTokens } from '../types';
import { logger } from '../middleware/logger';

// --- Notion ---

export function getNotionAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.NOTION_CLIENT_ID,
    response_type: 'code',
    owner: 'user',
    redirect_uri: config.NOTION_REDIRECT_URI,
    state,
  });
  return `https://api.notion.com/v1/oauth/authorize?${params}`;
}

export async function handleNotionCallback(
  code: string,
  oktaUserId: string,
  slackUserId: string
): Promise<void> {
  const credentials = Buffer.from(
    `${config.NOTION_CLIENT_ID}:${config.NOTION_CLIENT_SECRET}`
  ).toString('base64');

  const response = await axios.post(
    'https://api.notion.com/v1/oauth/token',
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.NOTION_REDIRECT_URI,
    },
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const existing = (await getUserTokens(oktaUserId)) ?? {
    slackUserId,
    oktaUserId,
  };
  await storeUserTokens({ ...existing, notionToken: response.data.access_token });
  logger.info({ oktaUserId }, 'Notion token stored');
}

// --- Confluence ---

export function getConfluenceAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.CONFLUENCE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: config.CONFLUENCE_REDIRECT_URI,
    scope: 'read:confluence-content.all read:confluence-space.summary',
    state,
  });
  return `https://auth.atlassian.com/authorize?${params}&audience=api.atlassian.com&prompt=consent`;
}

export async function handleConfluenceCallback(
  code: string,
  oktaUserId: string,
  slackUserId: string
): Promise<void> {
  const response = await axios.post(
    'https://auth.atlassian.com/oauth/token',
    {
      grant_type: 'authorization_code',
      client_id: config.CONFLUENCE_CLIENT_ID,
      client_secret: config.CONFLUENCE_CLIENT_SECRET,
      code,
      redirect_uri: config.CONFLUENCE_REDIRECT_URI,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const existing = (await getUserTokens(oktaUserId)) ?? { slackUserId, oktaUserId };
  await storeUserTokens({ ...existing, confluenceToken: response.data.access_token });
  logger.info({ oktaUserId }, 'Confluence token stored');
}

// --- Google Drive ---

function getOAuth2Client() {
  return new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_REDIRECT_URI
  );
}

export function getGoogleAuthUrl(state: string): string {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.readonly'],
    state,
    prompt: 'consent',
  });
}

export async function handleGoogleCallback(
  code: string,
  oktaUserId: string,
  slackUserId: string
): Promise<void> {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  const existing = (await getUserTokens(oktaUserId)) ?? { slackUserId, oktaUserId };
  await storeUserTokens({
    ...existing,
    googleDriveToken: tokens.access_token ?? undefined,
    googleDriveRefreshToken: tokens.refresh_token ?? undefined,
  });
  logger.info({ oktaUserId }, 'Google Drive token stored');
}

export async function refreshGoogleToken(tokens: UserTokens): Promise<string> {
  if (!tokens.googleDriveRefreshToken) {
    throw new Error('No refresh token available — user must re-authorize Google Drive');
  }
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    refresh_token: tokens.googleDriveRefreshToken,
  });
  const { credentials } = await oauth2Client.refreshAccessToken();
  return credentials.access_token!;
}

// --- Auth state helpers (CSRF protection) ---
const pendingStates = new Map<string, { oktaUserId: string; slackUserId: string; expiresAt: number }>();

export function createOAuthState(oktaUserId: string, slackUserId: string): string {
  const state = crypto.randomUUID();
  pendingStates.set(state, {
    oktaUserId,
    slackUserId,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
  });
  return state;
}

export function consumeOAuthState(
  state: string
): { oktaUserId: string; slackUserId: string } | null {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return { oktaUserId: entry.oktaUserId, slackUserId: entry.slackUserId };
}
