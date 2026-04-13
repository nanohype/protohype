/**
 * Rate Limiter — Redis-backed, shared-state, multi-instance safe
 *
 * MUST use Redis (ElastiCache), NOT in-memory Maps.
 * Multi-instance ECS deployment requires shared state across all tasks.
 *
 * Limits: 10 req/min (burst), 60 req/hr (sustained) — per user
 */
import type { RedisClientType } from 'redis';

const BURST_LIMIT = 10;
const SUSTAINED_LIMIT = 60;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: 'burst' | 'sustained';
}

export class RateLimiter {
  private redis: RedisClientType;

  constructor(redis: RedisClientType) {
    this.redis = redis;
  }

  async check(userId: string): Promise<RateLimitResult> {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const minuteKey = `rl:min:${userId}:${minuteBucket}`;
    const hourKey = `rl:hr:${userId}:${hourBucket}`;

    // Atomic pipeline — single Redis roundtrip
    const pipeline = this.redis.multi();
    pipeline.incr(minuteKey);
    pipeline.expire(minuteKey, 60);
    pipeline.incr(hourKey);
    pipeline.expire(hourKey, 3600);
    const results = await pipeline.exec();

    const minuteCount = results[0] as number;
    const hourCount = results[2] as number;

    if (minuteCount > BURST_LIMIT) return { allowed: false, retryAfterSeconds: 60, reason: 'burst' };
    if (hourCount > SUSTAINED_LIMIT) return { allowed: false, retryAfterSeconds: 3600, reason: 'sustained' };
    return { allowed: true };
  }
}
