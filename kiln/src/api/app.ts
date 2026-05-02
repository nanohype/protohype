// Hono app factory. The same code runs under @hono/aws-lambda in prod and
// under @hono/node-server in local dev. The factory takes Ports so tests can
// mount the app against fakes and hit endpoints without touching AWS.

import { Hono } from "hono";
import type { Ports } from "../core/ports.js";
import { authMiddleware } from "./middleware/auth.js";
import { tenantScopeMiddleware } from "./middleware/tenant-scope.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTeamRoutes } from "./routes/teams.js";
import { registerUpgradeRoutes } from "./routes/upgrades.js";

export function createApp(ports: Ports): Hono {
  const app = new Hono();

  registerHealthRoutes(app);

  // Everything under /teams/:teamId requires auth + tenant scope.
  const scoped = new Hono();
  scoped.use("*", authMiddleware(ports.identity));
  scoped.use("/teams/:teamId/*", tenantScopeMiddleware());
  scoped.use("/teams/:teamId", tenantScopeMiddleware());
  registerTeamRoutes(scoped, ports);
  registerUpgradeRoutes(scoped, ports);
  app.route("/", scoped);

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    ports.logger.error("unhandled request error", { error: String(err) });
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
