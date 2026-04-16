/**
 * Kiln — dependency upgrade automation service.
 * Hono HTTP server with graceful shutdown.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { initTelemetry, shutdownTelemetry, log } from "./telemetry/otel.js";
import { registerHealthRoutes } from "./api/routes/health.js";
import { registerTeamRoutes } from "./api/routes/teams.js";
import { registerUpgradeRoutes } from "./api/routes/upgrades.js";
import { startPoller, stopPoller } from "./workers/poller.js";
import { config } from "./config.js";

initTelemetry("kiln");

const app = new Hono();

// Register routes
registerHealthRoutes(app);
registerTeamRoutes(app);
registerUpgradeRoutes(app);

// 404 fallback
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Error handler — never leak internals
app.onError((err, c) => {
  log("error", "Unhandled request error", { error: String(err) });
  return c.json({ error: "Internal server error" }, 500);
});

const server = serve({
  fetch: app.fetch,
  port: config.server.port,
});

log("info", "Kiln service started", { port: config.server.port });

// Start the npm registry poller
startPoller();

// Graceful shutdown — finish current request before exiting
async function shutdown(signal: string): Promise<void> {
  log("info", `Received ${signal} — shutting down gracefully`);
  stopPoller();

  server.close(async () => {
    await shutdownTelemetry();
    log("info", "Kiln service stopped");
    process.exit(0);
  });

  // Force exit after 30s if graceful shutdown stalls
  setTimeout(() => {
    log("error", "Graceful shutdown timeout — forcing exit");
    process.exit(1);
  }, 30_000);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
