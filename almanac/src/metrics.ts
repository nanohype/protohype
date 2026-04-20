/**
 * CloudWatch metrics emission.
 *
 * Buffers metric data points in memory and flushes via PutMetricData on a
 * timer or when the buffer fills. CloudWatch accepts up to 1000 datums per
 * call; we cap at 150 to leave headroom and bound a single flush's payload.
 *
 * In NODE_ENV=test this is a no-op so unit + integration tests don't try to
 * reach AWS. Call flushMetrics() on shutdown to drain the buffer.
 */
import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
} from "@aws-sdk/client-cloudwatch";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { config } from "./config/index.js";
import { logger } from "./logger.js";

const NAMESPACE = "Almanac";
const FLUSH_INTERVAL_MS = 60_000;
const MAX_BUFFER_SIZE = 150;

const isTest = config.NODE_ENV === "test";

const client = new CloudWatchClient({
  region: config.AWS_REGION,
  requestHandler: new NodeHttpHandler({
    requestTimeout: 3000,
    connectionTimeout: 1000,
  }),
});

const buffer: MetricDatum[] = [];
let flushTimer: NodeJS.Timeout | null = null;

const baseDimensions = [{ Name: "Environment", Value: config.NODE_ENV }];

function toDimensions(extra?: Record<string, string>) {
  if (!extra) return baseDimensions;
  return [...baseDimensions, ...Object.entries(extra).map(([Name, Value]) => ({ Name, Value }))];
}

function enqueue(datum: MetricDatum) {
  if (isTest) return;
  buffer.push(datum);
  if (buffer.length >= MAX_BUFFER_SIZE) {
    void flushMetrics();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flushMetrics(), FLUSH_INTERVAL_MS);
    // Let Node exit even if the timer is still armed.
    flushTimer.unref?.();
  }
}

export async function flushMetrics(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = buffer.splice(0, buffer.length);
  if (batch.length === 0) return;
  try {
    await client.send(new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: batch }));
  } catch (err) {
    logger.error({ err, count: batch.length }, "CloudWatch PutMetricData failed; metrics lost");
  }
}

export function timing(name: string, ms: number, dimensions?: Record<string, string>): void {
  enqueue({
    MetricName: name,
    Value: ms,
    Unit: "Milliseconds",
    Timestamp: new Date(),
    Dimensions: toDimensions(dimensions),
  });
}

export function counter(name: string, value = 1, dimensions?: Record<string, string>): void {
  enqueue({
    MetricName: name,
    Value: value,
    Unit: "Count",
    Timestamp: new Date(),
    Dimensions: toDimensions(dimensions),
  });
}
