import type { Redis } from "ioredis";
import type { RateLimiterPort, RateLimitDecision, MetricsPort } from "../ports/index.js";
import type { Identity } from "../types/identity.js";
import { identityKey } from "../types/identity.js";
import { MetricNames } from "../metrics.js";
import type { Logger } from "../logger.js";

export interface RedisLimiterDeps {
  readonly redis: Redis;
  readonly windowSeconds: number;
  readonly limitPerWindow: number;
  readonly escalationTtlSeconds: number;
  readonly metrics: MetricsPort;
  readonly logger: Logger;
}

/**
 * Redis sliding-window limiter. One sorted-set per identity holds request
 * timestamps; ZREMRANGEBYSCORE prunes the window on every check. Hard-block
 * escalation sets a dedicated key whose TTL dictates back-off duration.
 *
 * Fail-open on Redis errors: palisade cannot brick legitimate users when the
 * limiter is the thing that's broken. Escalation writes fall through too.
 */
export function createRedisLimiter(deps: RedisLimiterDeps): RateLimiterPort {
  return {
    async check(identity: Identity): Promise<RateLimitDecision> {
      const key = identityKey(identity);
      const escalationKey = `${key}::escalated`;
      const now = Date.now();
      const windowMs = deps.windowSeconds * 1000;
      const minScore = now - windowMs;

      try {
        const escalated = await deps.redis.get(escalationKey);
        if (escalated) {
          const ttl = await deps.redis.pttl(escalationKey);
          return { allowed: false, remaining: 0, resetAt: now + Math.max(0, ttl) };
        }

        const windowKey = `${key}::window`;
        const pipe = deps.redis.pipeline();
        pipe.zremrangebyscore(windowKey, 0, minScore);
        pipe.zadd(windowKey, now, `${now}-${Math.random()}`);
        pipe.zcard(windowKey);
        pipe.pexpire(windowKey, windowMs);
        const results = await pipe.exec();
        const count = results?.[2]?.[1] as number | undefined;
        const requests = typeof count === "number" ? count : 0;
        const remaining = Math.max(0, deps.limitPerWindow - requests);
        const allowed = requests <= deps.limitPerWindow;
        return { allowed, remaining, resetAt: now + windowMs };
      } catch (err) {
        deps.logger.warn({ err, identity: key }, "Rate limiter fail-open — Redis error");
        return { allowed: true, remaining: deps.limitPerWindow, resetAt: now + windowMs };
      }
    },

    async escalate(identity: Identity, severity: "soft" | "hard"): Promise<void> {
      const key = identityKey(identity);
      const escalationKey = `${key}::escalated`;
      const ttl = severity === "hard" ? deps.escalationTtlSeconds : Math.floor(deps.escalationTtlSeconds / 4);
      try {
        await deps.redis.set(escalationKey, severity, "EX", ttl);
        deps.metrics.counter(MetricNames.RateLimitEscalated, 1, { severity });
      } catch (err) {
        deps.logger.warn({ err, identity: key }, "Rate limiter escalation write failed (fail-open)");
      }
    },
  };
}
