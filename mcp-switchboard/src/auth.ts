/**
 * Shared auth layer — reads API credentials from AWS Secrets Manager.
 * Caches secrets in module scope for the lifetime of a warm Lambda.
 * Never logs secret values.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { logger } from './logger.js';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

// Module-scope cache: secretName → parsed object
const cache = new Map<string, Record<string, string>>();

/**
 * Fetch and parse a secret from Secrets Manager.
 * Returns the parsed JSON object. Throws if the secret is missing or malformed.
 */
export async function getSecret(secretName: string): Promise<Record<string, string>> {
  if (cache.has(secretName)) {
    logger.debug('auth: cache hit', { secret: secretName });
    return cache.get(secretName)!;
  }

  logger.info('auth: fetching secret', { secret: secretName });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));

  if (!response.SecretString) {
    throw new Error(`Secret '${secretName}' has no string value`);
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(response.SecretString);
  } catch {
    throw new Error(`Secret '${secretName}' is not valid JSON`);
  }

  cache.set(secretName, parsed);
  return parsed;
}

/**
 * Clear the in-memory cache (useful in tests).
 */
export function clearSecretCache(): void {
  cache.clear();
}

// ─── Service-specific credential loaders ───────────────────────────────────

const PREFIX = process.env.SECRET_PREFIX ?? 'mcp-switchboard';

export async function hubspotCredentials(): Promise<{ apiKey: string }> {
  const s = await getSecret(`${PREFIX}/hubspot`);
  if (!s.apiKey) throw new Error('mcp-switchboard/hubspot secret missing apiKey');
  return { apiKey: s.apiKey };
}

export interface GoogleSACredentials {
  serviceAccountKey: Record<string, unknown>;
  impersonateEmail?: string;
}

async function googleCredentials(service: string): Promise<GoogleSACredentials> {
  const s = await getSecret(`${PREFIX}/${service}`);
  if (!s.serviceAccountKey) throw new Error(`mcp-switchboard/${service} secret missing serviceAccountKey`);
  let key: Record<string, unknown>;
  try {
    key = JSON.parse(s.serviceAccountKey);
  } catch {
    throw new Error(`mcp-switchboard/${service} serviceAccountKey is not valid JSON`);
  }
  return { serviceAccountKey: key, impersonateEmail: s.impersonateEmail };
}

export async function gdriveCredentials(): Promise<GoogleSACredentials> {
  return googleCredentials('gdrive');
}

export async function gcalCredentials(): Promise<GoogleSACredentials> {
  return googleCredentials('gcal');
}

export interface AnalyticsCredentials extends GoogleSACredentials {
  propertyId: string;
}

export async function analyticsCredentials(): Promise<AnalyticsCredentials> {
  const s = await getSecret(`${PREFIX}/analytics`);
  if (!s.serviceAccountKey) throw new Error('mcp-switchboard/analytics secret missing serviceAccountKey');
  if (!s.propertyId) throw new Error('mcp-switchboard/analytics secret missing propertyId');
  let key: Record<string, unknown>;
  try {
    key = JSON.parse(s.serviceAccountKey);
  } catch {
    throw new Error('mcp-switchboard/analytics serviceAccountKey is not valid JSON');
  }
  return { serviceAccountKey: key, propertyId: s.propertyId };
}

export async function gcseCredentials(): Promise<{ apiKey: string; engineId: string }> {
  const s = await getSecret(`${PREFIX}/gcse`);
  if (!s.apiKey) throw new Error('mcp-switchboard/gcse secret missing apiKey');
  if (!s.engineId) throw new Error('mcp-switchboard/gcse secret missing engineId');
  return { apiKey: s.apiKey, engineId: s.engineId };
}

export async function stripeCredentials(): Promise<{ secretKey: string }> {
  const s = await getSecret(`${PREFIX}/stripe`);
  if (!s.secretKey) throw new Error('mcp-switchboard/stripe secret missing secretKey');
  return { secretKey: s.secretKey };
}
