import { describe, it, expect, vi } from "vitest";
import { createMemoryLimiter } from "./memory-limiter.js";

describe("in-memory rate limiter — behavior mirrors the Redis semantic", () => {
  it("allows requests below the limit", async () => {
    const limiter = createMemoryLimiter({ windowSeconds: 60, limitPerWindow: 3, escalationTtlSeconds: 600 });
    const identity = { ip: "1.2.3.4" };
    for (let i = 0; i < 3; i++) {
      const d = await limiter.check(identity);
      expect(d.allowed).toBe(true);
    }
  });

  it("blocks when limit is exceeded in the window", async () => {
    const limiter = createMemoryLimiter({ windowSeconds: 60, limitPerWindow: 2, escalationTtlSeconds: 600 });
    const identity = { ip: "1.2.3.4" };
    await limiter.check(identity);
    await limiter.check(identity);
    const third = await limiter.check(identity);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("escalation short-circuits check() until TTL elapses", async () => {
    vi.useFakeTimers();
    const limiter = createMemoryLimiter({ windowSeconds: 60, limitPerWindow: 100, escalationTtlSeconds: 1 });
    const identity = { ip: "9.9.9.9" };
    await limiter.escalate(identity, "hard");
    expect((await limiter.check(identity)).allowed).toBe(false);
    vi.advanceTimersByTime(1_100);
    expect((await limiter.check(identity)).allowed).toBe(true);
    vi.useRealTimers();
  });

  it("soft escalation uses 1/4 of the hard TTL", async () => {
    vi.useFakeTimers();
    const limiter = createMemoryLimiter({ windowSeconds: 60, limitPerWindow: 100, escalationTtlSeconds: 4 });
    const identity = { ip: "9.9.9.9" };
    await limiter.escalate(identity, "soft");
    expect((await limiter.check(identity)).allowed).toBe(false);
    // Soft TTL = 1 second
    vi.advanceTimersByTime(1_100);
    expect((await limiter.check(identity)).allowed).toBe(true);
    vi.useRealTimers();
  });
});
