import type { CachedVerdict, SemanticCachePort } from "../ports/index.js";

/** In-process verdict cache. TTL enforced lazily on read. */
export function createMemoryCache(): SemanticCachePort {
  const store = new Map<string, { verdict: CachedVerdict; exp: number }>();
  return {
    async get(key): Promise<CachedVerdict | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.exp < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.verdict;
    },
    async set(key, verdict, ttlSeconds): Promise<void> {
      store.set(key, { verdict, exp: Date.now() + ttlSeconds * 1000 });
    },
  };
}
