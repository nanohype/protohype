/**
 * Google service account JWT auth.
 *
 * Given a service account key JSON (the exact file Google's IAM console
 * generates), mints a short-lived JWT, exchanges it at Google's token
 * endpoint for an access token, and caches the access token in Lambda
 * memory until ~60 seconds before it expires.
 *
 * No external deps — uses Node's built-in crypto.createSign for RS256.
 */

import { createSign } from 'crypto';

export interface GoogleServiceAccount {
  type: 'service_account';
  project_id?: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

interface TokenCacheEntry {
  accessToken: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, TokenCacheEntry>();
const CACHE_SAFETY_MARGIN_MS = 60 * 1000;
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

export function isServiceAccount(creds: unknown): creds is GoogleServiceAccount {
  if (!creds || typeof creds !== 'object') return false;
  const c = creds as Record<string, unknown>;
  return c.type === 'service_account' && typeof c.private_key === 'string' && typeof c.client_email === 'string';
}

function base64UrlEncode(input: string | Buffer): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Build and sign a JWT assertion for the Google token endpoint.
 * Claims: iss (service account email), scope, aud (token URI), iat, exp.
 */
export function signJwt(sa: GoogleServiceAccount, scope: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) };
  const claims = {
    iss: sa.client_email,
    scope,
    aud: sa.token_uri ?? DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(sa.private_key);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function exchangeJwtForToken(sa: GoogleServiceAccount, jwt: string): Promise<{ accessToken: string; expiresIn: number }> {
  const tokenUri = sa.token_uri ?? DEFAULT_TOKEN_URI;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    // Surface Google's error to CloudWatch without leaking the JWT itself.
    throw new Error(`Google token exchange failed (${res.status})`);
  }
  const payload = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (payload.error || !payload.access_token) {
    throw new Error(`Google token exchange returned error: ${payload.error ?? 'missing access_token'}`);
  }
  return { accessToken: payload.access_token, expiresIn: payload.expires_in ?? 3600 };
}

/**
 * Get a Google access token for the given service-account + scope.
 * Caches per (client_email, scope) until near expiry.
 */
export async function getGoogleAccessToken(sa: GoogleServiceAccount, scope: string): Promise<string> {
  const cacheKey = `${sa.client_email}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - CACHE_SAFETY_MARGIN_MS) {
    return cached.accessToken;
  }
  const jwt = signJwt(sa, scope);
  const { accessToken, expiresIn } = await exchangeJwtForToken(sa, jwt);
  tokenCache.set(cacheKey, { accessToken, expiresAt: Date.now() + expiresIn * 1000 });
  return accessToken;
}

// Exported for testing
export function _clearTokenCache(): void { tokenCache.clear(); }
