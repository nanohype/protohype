// Poller Lambda handler — EventBridge scheduled event → runPoller.

import type { EventBridgeEvent } from "aws-lambda";
import { composePorts } from "../adapters/compose.js";
import { loadConfig } from "../config.js";
import { initTelemetry } from "../telemetry/init.js";
import { runPoller, type PollerMetrics } from "../workers/poller.js";

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
  return { ports, config };
})();

export async function handler(
  _event: EventBridgeEvent<"Scheduled Event", unknown>,
): Promise<PollerMetrics> {
  const { ports } = await bootstrap;
  return runPoller(ports);
}
