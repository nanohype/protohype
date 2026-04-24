import type { Redis } from "ioredis";
import type { CachedVerdict, SemanticCachePort } from "../ports/index.js";

/** Redis-backed verdict cache. Same hash space as the rate limiter; keys are namespaced. */
export function createRedisCache(redis: Redis): SemanticCachePort {
  return {
    async get(key): Promise<CachedVerdict | null> {
      try {
        const raw = await redis.get(`verdict:${key}`);
        return raw ? (JSON.parse(raw) as CachedVerdict) : null;
      } catch {
        return null;
      }
    },
    async set(key, verdict, ttlSeconds): Promise<void> {
      try {
        await redis.set(`verdict:${key}`, JSON.stringify(verdict), "EX", ttlSeconds);
      } catch {
        // swallow — cache is optional, not load-bearing
      }
    },
  };
}
