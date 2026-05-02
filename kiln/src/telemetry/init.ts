// OTel SDK init — runs in the Lambda cold-start path. Memoized so a concurrent
// cold-start burst doesn't fetch the OTLP auth credential more than once.
//
// Why programmatic (not the ADOT managed layer): the layer reads OTLP config
// from env vars at layer-load time. That forces the `Authorization: Basic ...`
// header to live in `environment:` on the Lambda resource, readable by any
// principal with `lambda:GetFunctionConfiguration`, logged by CloudTrail on
// every describe, and baked in until redeploy. Fetching at cold-start via the
// Lambda's `secretsmanager:GetSecretValue` permission keeps the credential
// inside Secrets Manager's perimeter.
//
// Best-effort: if init fails, handlers log a warning and continue WITHOUT
// tracing. Losing a span must not block the pipeline.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

export interface TelemetryInitConfig {
  enabled: boolean;
  serviceName: string;
  otlpEndpoint?: string;
  otlpSecretArn?: string;
  resourceAttributes: string;
  metricExportIntervalMs: number;
  region: string;
}

let initPromise: Promise<boolean> | undefined;

export function __resetTelemetryInitForTests(): void {
  initPromise = undefined;
}

/**
 * Idempotent. Returns true if OTel is active after the call, false if init
 * was skipped (disabled or missing config) or failed.
 */
export function initTelemetry(cfg: TelemetryInitConfig): Promise<boolean> {
  if (!initPromise) {
    initPromise = initInner(cfg).catch((err) => {
      emitStderr("warn", "OTel init failed; continuing without telemetry", {
        error: err instanceof Error ? err.message : String(err),
      });
      initPromise = undefined;
      return false;
    });
  }
  return initPromise;
}

async function initInner(cfg: TelemetryInitConfig): Promise<boolean> {
  if (!cfg.enabled) return false;
  if (!cfg.otlpEndpoint || !cfg.otlpSecretArn) {
    emitStderr("info", "telemetry enabled but OTLP endpoint/secret not set; skipping", {});
    return false;
  }

  const sm = new SecretsManagerClient({ region: cfg.region });
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: cfg.otlpSecretArn }));
  if (!resp.SecretString) throw new Error("OTLP auth secret has no string value");
  const parsed = JSON.parse(resp.SecretString) as { basic_auth?: unknown };
  if (typeof parsed.basic_auth !== "string" || parsed.basic_auth.length === 0) {
    throw new Error("OTLP auth secret is missing a string `basic_auth` field");
  }

  const headers = { Authorization: `Basic ${parsed.basic_auth}` };
  const endpoint = cfg.otlpEndpoint.replace(/\/$/, "");
  const resource = resourceFromAttributes({
    "service.name": cfg.serviceName,
    ...parseResourceAttrs(cfg.resourceAttributes),
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, headers }),
      exportIntervalMillis: cfg.metricExportIntervalMs,
    }),
    logRecordProcessors: [
      new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers })),
    ],
    instrumentations: [
      // Auto-instruments http/fetch/aws-sdk/aws-lambda. Filesystem + DNS off —
      // noisy and we don't need them.
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  });

  sdk.start();
  emitStderr("info", "OTel SDK started", { service: cfg.serviceName, endpoint });
  return true;
}

function parseResourceAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=");
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

/**
 * Direct stderr emission — we cannot use our own logger here (circular init).
 */
function emitStderr(level: string, message: string, meta: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: "kiln-telemetry-init",
      message,
      ...meta,
    }),
  );
}
