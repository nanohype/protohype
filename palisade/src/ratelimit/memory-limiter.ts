import type { RateLimiterPort, RateLimitDecision } from "../ports/index.js";
import type { Identity } from "../types/identity.js";
import { identityKey } from "../types/identity.js";

export interface MemoryLimiterConfig {
  readonly windowSeconds: number;
  readonly limitPerWindow: number;
  readonly escalationTtlSeconds: number;
}

/**
 * In-process sliding-window limiter — test + dev only. Not multi-instance
 * safe; production uses Redis.
 */
export function createMemoryLimiter(config: MemoryLimiterConfig): RateLimiterPort & { reset(): void } {
  const windows = new Map<string, number[]>();
  const escalations = new Map<string, number>();

  return {
    async check(identity: Identity): Promise<RateLimitDecision> {
      const key = identityKey(identity);
      const now = Date.now();
      const exp = escalations.get(key);
      if (exp && exp > now) return { allowed: false, remaining: 0, resetAt: exp };
      if (exp && exp <= now) escalations.delete(key);
      const timestamps = (windows.get(key) ?? []).filter((t) => t > now - config.windowSeconds * 1000);
      timestamps.push(now);
      windows.set(key, timestamps);
      const remaining = Math.max(0, config.limitPerWindow - timestamps.length);
      return { allowed: timestamps.length <= config.limitPerWindow, remaining, resetAt: now + config.windowSeconds * 1000 };
    },
    async escalate(identity: Identity, severity: "soft" | "hard"): Promise<void> {
      const key = identityKey(identity);
      const ttl = severity === "hard" ? config.escalationTtlSeconds : Math.floor(config.escalationTtlSeconds / 4);
      escalations.set(key, Date.now() + ttl * 1000);
    },
    reset: () => {
      windows.clear();
      escalations.clear();
    },
  };
}
