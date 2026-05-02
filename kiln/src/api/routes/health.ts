import type { Hono } from "hono";

export function registerHealthRoutes(app: Hono): void {
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", (c) => c.json({ status: "ready" }));
}
