// API Lambda handler — API Gateway HTTP API event → Hono app.
// Composition + telemetry init happen at cold start; subsequent invocations
// reuse the instance.

import { handle } from "@hono/aws-lambda";
import { composePorts } from "../adapters/compose.js";
import { createApp } from "../api/app.js";
import { loadConfig } from "../config.js";
import { initTelemetry } from "../telemetry/init.js";

const bootstrap = (async () => {
  const config = loadConfig();
  await initTelemetry({
    enabled: config.telemetry.enabled,
    serviceName: config.telemetry.serviceName,
    ...(config.telemetry.otlpEndpoint ? { otlpEndpoint: config.telemetry.otlpEndpoint } : {}),
    ...(config.telemetry.otlpSecretArn ? { otlpSecretArn: config.telemetry.otlpSecretArn } : {}),
    resourceAttributes: config.telemetry.resourceAttributes,
    metricExportIntervalMs: config.telemetry.metricExportIntervalMs,
    region: config.region,
  });
  const ports = await composePorts(config);
  return { app: createApp(ports), config };
})();

export const handler: ReturnType<typeof handle> = async (event, context) => {
  const { app } = await bootstrap;
  return handle(app)(event, context);
};
