import type { Hono } from "hono";

export function registerHealthRoutes(app: Hono): void {
  app.get("/healthz", (c) => c.json({ status: "ok", service: "kiln", ts: new Date().toISOString() }));

  app.get("/readyz", (c) => {
    // Could add DB connectivity check here in production
    return c.json({ status: "ready", service: "kiln", ts: new Date().toISOString() });
  });
}
