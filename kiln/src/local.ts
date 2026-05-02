// Local dev entry — runs the Hono API on :3000 and a setInterval poller so
// the full pipeline can be exercised against DynamoDB Local + a fake LLM.
// Not bundled into any Lambda.

import { serve } from "@hono/node-server";
import { composePorts } from "./adapters/compose.js";
import { createApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { runPoller } from "./workers/poller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ports = await composePorts(config);
  const app = createApp(ports);

  const server = serve({ fetch: app.fetch, port: 3000 });
  ports.logger.info("kiln local server listening", { port: 3000 });

  const pollerTimer = setInterval(
    () => {
      runPoller(ports).catch((e) => ports.logger.error("poller tick failed", { error: String(e) }));
    },
    config.poller.intervalMinutes * 60 * 1000,
  );

  const shutdown = (signal: string): void => {
    ports.logger.info("shutting down", { signal });
    clearInterval(pollerTimer);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("fatal", e);
  process.exit(1);
});
