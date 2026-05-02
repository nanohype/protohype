// Rate limiter concurrency proof — N concurrent tryAcquire calls against an
// empty bucket with capacity C should succeed exactly C times. This is the
// thread-safety test for the conditional UpdateItem pattern.

import { beforeAll, expect, it } from "vitest";
import { adaptersAgainstLocal, buildDocClient, integrationDescribe } from "./shared.js";

integrationDescribe("DynamoDB rate limiter", () => {
  let rate: ReturnType<typeof adaptersAgainstLocal>["rateLimiter"];

  beforeAll(() => {
    rate = adaptersAgainstLocal(buildDocClient()).rateLimiter;
  });

  it("capacity 5 with 10 concurrent acquirers → exactly 5 succeed", async () => {
    const key = `rate-test-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => rate.tryAcquire(key, 5, 0)),
    );
    const successes = results.filter(Boolean).length;
    expect(successes).toBe(5);
  });

  it("empties then refills over time (refillPerSec > 0)", async () => {
    const key = `refill-test-${Date.now()}`;
    // Drain capacity 2 with refill = 10/sec.
    const first = await rate.tryAcquire(key, 2, 10);
    const second = await rate.tryAcquire(key, 2, 10);
    const third = await rate.tryAcquire(key, 2, 10);
    expect([first, second, third]).toEqual([true, true, false]);
    // Wait for one token to refill.
    await new Promise((r) => setTimeout(r, 120));
    const fourth = await rate.tryAcquire(key, 2, 10);
    expect(fourth).toBe(true);
  });
});
