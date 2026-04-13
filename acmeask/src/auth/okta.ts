/**
 * Okta identity bridge — resolves Slack user IDs to Okta user IDs via SCIM.
 * Caches the mapping in memory with a 15-minute TTL (SCIM sync interval).
 */
import axios from 'axios';
import { config } from '../config';
import { logger } from '../middleware/logger';

const cache = new Map<string, { oktaUserId: string; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

export async function resolveOktaUserId(slackUserId: string): Promise<string> {
  const cached = cache.get(slackUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.oktaUserId;
  }

  // Query Okta SCIM API for user with Slack externalId attribute
  // Slack SCIM provisioning sets the Slack user ID in the externalId field
  const response = await axios.get(
    `${config.OKTA_DOMAIN}/api/v1/users`,
    {
      params: { filter: `profile.slackId eq "${slackUserId}"` },
      headers: {
        Authorization: `SSWS ${config.OKTA_CLIENT_SECRET}`,
        Accept: 'application/json',
      },
    }
  );

  const users = response.data as Array<{ id: string }>;
  if (users.length === 0) {
    logger.warn({ slackUserId }, 'No Okta user found for Slack user ID');
    throw new Error(`No Okta user found for Slack user ${slackUserId}`);
  }

  const oktaUserId = users[0].id;
  cache.set(slackUserId, { oktaUserId, expiresAt: Date.now() + CACHE_TTL_MS });
  return oktaUserId;
}
