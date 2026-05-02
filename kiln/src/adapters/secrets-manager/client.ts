// Secrets Manager adapter with module-scope cache. Warm Lambda invocations
// reuse the cached value; cold starts pay the GetSecretValue cost once.
//
// TTL-only; we do NOT version-pin. If the secret is rotated, a running Lambda
// keeps the stale value until its TTL expires. That's acceptable because we
// set TTL ≤ half the shortest credential lifetime used.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SecretsPort } from "../../core/ports.js";
import { err, ok } from "../../types.js";

export interface SecretsAdapterConfig {
  region: string;
  timeoutMs: number;
  ttlMs: number;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export function makeSecretsAdapter(cfg: SecretsAdapterConfig): SecretsPort {
  const client = new SecretsManagerClient({ region: cfg.region });
  const cache = new Map<string, CacheEntry>();

  return {
    async getString(arn) {
      const now = Date.now();
      const cached = cache.get(arn);
      if (cached && cached.expiresAt > now) return ok(cached.value);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const resp = await client.send(new GetSecretValueCommand({ SecretId: arn }), {
          abortSignal: controller.signal,
        });
        const value = resp.SecretString;
        if (!value) return err({ kind: "NotFound", what: `secretsmanager:${arn}` });
        cache.set(arn, { value, expiresAt: now + cfg.ttlMs });
        return ok(value);
      } catch (e) {
        return err({ kind: "Upstream", source: "secrets-manager", message: asMessage(e) });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
