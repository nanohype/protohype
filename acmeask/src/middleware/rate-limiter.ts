/**
 * In-memory per-user rate limiter — 20 queries/hour per Okta user ID.
 * Production: replace with Redis-backed limiter for multi-instance deployments.
 */
import { config } from '../config';

const WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface UserBucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, UserBucket>();

export function checkRateLimit(oktaUserId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const existing = buckets.get(oktaUserId);

  if (!existing || now - existing.windowStart > WINDOW_MS) {
    buckets.set(oktaUserId, { count: 1, windowStart: now });
    return { allowed: true, remaining: config.MAX_QUERIES_PER_HOUR - 1 };
  }

  if (existing.count >= config.MAX_QUERIES_PER_HOUR) {
    return { allowed: false, remaining: 0 };
  }

  existing.count += 1;
  return { allowed: true, remaining: config.MAX_QUERIES_PER_HOUR - existing.count };
}
