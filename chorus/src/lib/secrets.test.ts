import { describe, it, expect, vi } from 'vitest';
import type { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createSecretsClient, type SecretsManagerPort } from './secrets.js';

function clientReturning(...values: Array<string | undefined>): {
  port: SecretsManagerPort;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  for (const v of values) send.mockResolvedValueOnce({ SecretString: v });
  return { port: { send } as unknown as SecretsManagerPort, send };
}

describe('createSecretsClient.getSecretString', () => {
  it('returns the SecretString from the underlying SDK', async () => {
    const { port, send } = clientReturning('hello-secret');
    const c = createSecretsClient({ client: port });
    expect(await c.getSecretString('chorus/foo')).toBe('hello-secret');
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]?.[0] as GetSecretValueCommand;
    expect(cmd.input.SecretId).toBe('chorus/foo');
  });

  it('caches subsequent calls within the TTL', async () => {
    const { port, send } = clientReturning('v1', 'v2');
    let now = 1_000;
    const c = createSecretsClient({ client: port, ttlMs: 1_000, now: () => now });
    expect(await c.getSecretString('k')).toBe('v1');
    now = 1_500;
    expect(await c.getSecretString('k')).toBe('v1');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refetches after TTL elapses', async () => {
    const { port, send } = clientReturning('v1', 'v2');
    let now = 0;
    const c = createSecretsClient({ client: port, ttlMs: 1_000, now: () => now });
    expect(await c.getSecretString('k')).toBe('v1');
    now = 2_000;
    expect(await c.getSecretString('k')).toBe('v2');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('throws when the secret has no string value', async () => {
    const { port } = clientReturning(undefined);
    const c = createSecretsClient({ client: port });
    await expect(c.getSecretString('empty')).rejects.toThrow(/no string value/);
  });

  it('clearCache forces a refetch on the next call', async () => {
    const { port, send } = clientReturning('v1', 'v2');
    const c = createSecretsClient({ client: port });
    expect(await c.getSecretString('k')).toBe('v1');
    c.clearCache();
    expect(await c.getSecretString('k')).toBe('v2');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('createSecretsClient.prewarm', () => {
  it('fetches all named secrets in parallel and populates the cache', async () => {
    const { port, send } = clientReturning('a-val', 'b-val');
    const c = createSecretsClient({ client: port });
    await c.prewarm(['a', 'b']);
    expect(send).toHaveBeenCalledTimes(2);
    // subsequent getSecretString should hit cache
    expect(await c.getSecretString('a')).toBe('a-val');
    expect(await c.getSecretString('b')).toBe('b-val');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('throws fast when any secret is missing', async () => {
    const { port } = clientReturning('ok', undefined);
    const c = createSecretsClient({ client: port });
    await expect(c.prewarm(['a', 'b'])).rejects.toThrow(/no string value/);
  });
});
