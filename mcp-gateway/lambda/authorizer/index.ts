/**
 * Bearer Token Lambda Authorizer
 * Validates Authorization: Bearer <token> against Secrets Manager.
 * Fail-closed: returns { isAuthorized: false } on any error.
 * Constant-time token comparison (timing attack safe).
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

interface HttpApiAuthorizerEvent {
  type: string; headers?: Record<string, string>;
}
interface SimpleAuthorizerResult {
  isAuthorized: boolean; context?: Record<string, string | number | boolean>;
}

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-west-2' });
const tokenCache = new Map<string, number>();
const CACHE_TTL_MS = 4 * 60 * 1000;
let cachedSecretValue: string | null = null;
let secretCacheExpiry = 0;

async function getExpectedToken(): Promise<string> {
  const now = Date.now();
  if (cachedSecretValue && now < secretCacheExpiry) return cachedSecretValue;
  const secretArn = process.env.GATEWAY_SECRET_ARN;
  if (!secretArn) throw new Error('GATEWAY_SECRET_ARN not set');
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) throw new Error('Secret has no string value');
  let token: string;
  try { const parsed = JSON.parse(result.SecretString) as Record<string, string>; token = parsed['token'] ?? result.SecretString; }
  catch { token = result.SecretString; }
  cachedSecretValue = token;
  secretCacheExpiry = now + CACHE_TTL_MS;
  return token;
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? (match[1] ?? null) : null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still iterate for the length of the longer string to keep timing uniform.
    // The accumulator is intentionally discarded — the result is always false here.
    let _sink = 0;
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) _sink |= (a.charCodeAt(i % a.length) ^ b.charCodeAt(i % b.length));
    void _sink;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

function evictStaleTokens(): void {
  const now = Date.now();
  for (const [token, expiry] of tokenCache.entries()) { if (now >= expiry) tokenCache.delete(token); }
}

export const handler = async (event: HttpApiAuthorizerEvent): Promise<SimpleAuthorizerResult> => {
  try {
    const authHeader = event.headers?.['authorization'] ?? event.headers?.['Authorization'];
    const token = extractBearerToken(authHeader);
    if (!token) { console.log('No bearer token in request'); return { isAuthorized: false }; }
    const cached = tokenCache.get(token);
    if (cached !== undefined && Date.now() < cached) return { isAuthorized: true, context: { cached: true } };
    const expectedToken = await getExpectedToken();
    const isValid = constantTimeEquals(token, expectedToken);
    if (isValid) {
      tokenCache.set(token, Date.now() + CACHE_TTL_MS);
      if (tokenCache.size > 100) evictStaleTokens();
    } else {
      console.log('Invalid bearer token');
    }
    return { isAuthorized: isValid, context: isValid ? { authenticated: true } : {} };
  } catch (err) {
    console.error('Authorizer error:', err);
    return { isAuthorized: false }; // Fail closed
  }
};
