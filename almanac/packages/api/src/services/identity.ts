/**
 * Identity Service — Slack user ID → Okta user ID via SCIM API
 * Uses one service-account API token (not per-user). Per-instance TTL cache is acceptable.
 */
import axios from 'axios';

const OKTA_SCIM_BASE = process.env.OKTA_SCIM_BASE_URL!;
const OKTA_API_TOKEN = process.env.OKTA_API_TOKEN!;

const cache = new Map<string, { oktaId: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function resolveOktaUserId(slackUserId: string): Promise<string> {
  const cached = cache.get(slackUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.oktaId;

  const response = await axios.get(
    `${OKTA_SCIM_BASE}/api/v1/users?search=profile.slackUserId eq "${slackUserId}"`,
    { headers: { Authorization: `SSWS ${OKTA_API_TOKEN}`, Accept: 'application/json' }, timeout: 5000 },
  );

  const users = response.data as Array<{ id: string }>;
  if (!users?.length) throw new Error(`No Okta user found for Slack ID: ${slackUserId}`);

  const oktaId = users[0]!.id;
  cache.set(slackUserId, { oktaId, expiresAt: Date.now() + CACHE_TTL_MS });
  return oktaId;
}
