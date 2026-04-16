import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { awsRegion, AWS_MAX_ATTEMPTS } from './aws.js';

/**
 * Tiny port over the SecretsManager SDK. Only the `send` shape we
 * use, returning a value with `SecretString`. Tests pass a `vi.fn`
 * impl and never `vi.mock('@aws-sdk/client-secrets-manager')`.
 */
export interface SecretsManagerPort {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

export interface SecretsClient {
  getSecretString(secretName: string): Promise<string>;
  clearCache(): void;
  /**
   * Fetch every named secret in parallel and cache the results. Throws
   * on the first missing or unreadable secret so callers can fail-fast
   * at startup instead of hanging a request on Secrets Manager later.
   */
  prewarm(secretNames: string[]): Promise<void>;
}

export interface CreateSecretsClientDeps {
  client?: SecretsManagerPort;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL = 5 * 60 * 1000;

function defaultClient(): SecretsManagerPort {
  return new SecretsManagerClient({ region: awsRegion(), maxAttempts: AWS_MAX_ATTEMPTS });
}

export function createSecretsClient(deps: CreateSecretsClientDeps = {}): SecretsClient {
  const client = deps.client ?? defaultClient();
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { value: string; expiresAt: number }>();

  async function getSecretString(secretName: string): Promise<string> {
    const t = now();
    const cached = cache.get(secretName);
    if (cached && cached.expiresAt > t) return cached.value;
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
    const value = response.SecretString;
    if (!value) throw new Error(`Secret "${secretName}" has no string value`);
    cache.set(secretName, { value, expiresAt: t + ttlMs });
    return value;
  }

  return {
    getSecretString,
    clearCache() {
      cache.clear();
    },
    async prewarm(secretNames) {
      await Promise.all(secretNames.map((n) => getSecretString(n)));
    },
  };
}

const _default = createSecretsClient();
export const getSecretString = _default.getSecretString.bind(_default);
export const clearSecretsCache = _default.clearCache.bind(_default);
export const prewarmSecrets = _default.prewarm.bind(_default);
