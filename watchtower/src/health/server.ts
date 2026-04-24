import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Logger } from "../logger.js";

// ── Health Server ───────────────────────────────────────────────────
//
// Minimal Hono HTTP server on a separate port. `/health` is a pure
// liveness probe (always 200 if the process is alive). `/readyz`
// iterates the named readiness checks and returns 503 if any fail.
//
// Named checks keep the contract flexible — watchtower runs multiple
// queue consumers in-process (crawl / classify / publish / audit).
// Each subsystem registers its own callback.
//

export interface HealthServerConfig {
  readonly port: number;
  /**
   * Named readiness checks. `/readyz` returns 200 iff every check
   * returns true. Check names surface in the JSON response so
   * operators can see which subsystem failed.
   */
  readonly checks: Readonly<Record<string, () => boolean>>;
  readonly logger: Logger;
}

export interface HealthServer {
  /** Start listening on the configured port. */
  start(): void;
  /** Stop the server. */
  stop(): Promise<void>;
  /** Underlying Hono app — exposed for in-process testing. */
  readonly app: Hono;
}

/** Build a Hono app wired to the named readiness checks. */
export function buildHealthApp(checks: Readonly<Record<string, () => boolean>>): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "alive" }));
  app.get("/readyz", (c) => {
    const results: Record<string, "ok" | "failing"> = {};
    let allOk = true;
    for (const [name, check] of Object.entries(checks)) {
      const ok = check();
      results[name] = ok ? "ok" : "failing";
      if (!ok) allOk = false;
    }
    return c.json({ status: allOk ? "ready" : "not_ready", checks: results }, allOk ? 200 : 503);
  });
  return app;
}

/** Create a health server driven by named readiness callbacks. */
export function createHealthServer(config: HealthServerConfig): HealthServer {
  const { port, checks, logger } = config;
  const app = buildHealthApp(checks);
  let server: ReturnType<typeof serve> | null = null;

  function start(): void {
    server = serve({ fetch: app.fetch, port }, () => {
      logger.info(`Health server listening on http://0.0.0.0:${port}`);
    });
  }

  async function stop(): Promise<void> {
    if (!server) return;
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = null;
    logger.info("Health server stopped");
  }

  return { start, stop, app };
}
