// Upgrader Lambda handler — SQS FIFO batch → runUpgrader per record.
// batchSize = 1 on the event source (one job per invocation); we still use
// reportBatchItemFailures so partial failures during edge cases don't poison
// the whole batch if that changes.
//
// Trace context: each SQS message carries W3C traceparent attributes injected
// by the poller. We extract and continue the trace so Grafana Cloud Tempo
// shows a single end-to-end span tree across the Lambda → SQS → Lambda hop.

import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { composePorts } from "../adapters/compose.js";
import { loadConfig } from "../config.js";
import { initTelemetry } from "../telemetry/init.js";
import { context as otelContext, extractSqsTraceContext } from "../telemetry/tracing.js";
import type { UpgradeJob } from "../types.js";
import { runUpgrader } from "../workers/upgrader.js";

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

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const { ports, config } = await bootstrap;
  const failed: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    // Continue the trace started by the poller — AWS Lambda's message-attribute
    // types are slightly different from the SQS client's, but the StringValue
    // shape is identical so the extractor handles both.
    const parentCtx = extractSqsTraceContext(
      record.messageAttributes as unknown as Parameters<typeof extractSqsTraceContext>[0],
    );
    await otelContext.with(parentCtx, async () => {
      try {
        const job = JSON.parse(record.body) as UpgradeJob;
        const outcome = await runUpgrader(ports, config, job);
        if (outcome.kind === "failed" && outcome.message !== "duplicate") {
          failed.push({ itemIdentifier: record.messageId });
        }
      } catch (e) {
        ports.logger.error("upgrader record parse/run failed", {
          messageId: record.messageId,
          error: e instanceof Error ? e.message : String(e),
        });
        failed.push({ itemIdentifier: record.messageId });
      }
    });
  }

  return { batchItemFailures: failed };
}
