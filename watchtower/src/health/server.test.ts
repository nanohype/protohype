import { describe, it, expect } from "vitest";
import { buildHealthApp } from "./server.js";

// ── Health Endpoint Tests ───────────────────────────────────────────
//
// Exercises the handler logic against the in-process Hono app via
// `app.request()` — no network, no port binding. `buildHealthApp` is
// the single source of truth for request semantics; createHealthServer
// composes it behind a socket.
//

describe("/health", () => {
  it("always returns 200 alive", async () => {
    const app = buildHealthApp({ "consumer-crawl": () => false });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.status).toBe("alive");
  });
});

describe("/readyz", () => {
  it("returns 200 ready when all checks pass", async () => {
    const app = buildHealthApp({
      "consumer-crawl": () => true,
      "consumer-classify": () => true,
    });
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, string>;
    };
    expect(body.status).toBe("ready");
    expect(body.checks["consumer-crawl"]).toBe("ok");
    expect(body.checks["consumer-classify"]).toBe("ok");
  });

  it("returns 503 not_ready when any check fails", async () => {
    const app = buildHealthApp({
      "consumer-crawl": () => true,
      "consumer-classify": () => false,
    });
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, string>;
    };
    expect(body.status).toBe("not_ready");
    expect(body.checks["consumer-crawl"]).toBe("ok");
    expect(body.checks["consumer-classify"]).toBe("failing");
  });

  it("returns 200 with empty checks map when no subsystems registered", async () => {
    const app = buildHealthApp({});
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: Record<string, string> };
    expect(body.checks).toEqual({});
  });
});
