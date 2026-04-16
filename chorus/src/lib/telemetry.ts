import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics,
  trace,
  type Tracer,
  type Meter,
} from '@opentelemetry/api';
import { logs, type Logger } from '@opentelemetry/api-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions/incubating';

/**
 * OpenTelemetry bootstrap. Invoked once per process before any user
 * code runs — either via `node --import ./dist/src/lib/telemetry-register.js`
 * in production containers, or explicitly at the top of test setups
 * that need tracing. The SDK exports OTLP HTTP to localhost:4318 by
 * default (the ADOT sidecar listens there in Fargate); override via
 * `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * Disabled when `OTEL_SDK_DISABLED=true` — vitest, local dev without
 * a collector, and any tooling (tsc, eslint) that imports app code
 * all set this so they don't spin up the SDK.
 */

let sdk: NodeSDK | undefined;
let initialized = false;

export interface InitTelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  /** Ignored when set — useful for tests that want to re-init. */
  forceReinit?: boolean;
}

export function initTelemetry(opts: InitTelemetryOptions): void {
  if (process.env['OTEL_SDK_DISABLED'] === 'true') return;
  if (initialized && !opts.forceReinit) return;

  if (process.env['OTEL_LOG_LEVEL'] === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_NAMESPACE]: 'chorus',
    [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? process.env['npm_package_version'] ?? '0.0.0',
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env['DEPLOYMENT_ENV'] ?? 'unknown',
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 30_000,
    }),
    // Log records come from `observability.ts`'s dual-write path: every
    // `logger.{info,warn,error}` line is both written to stdout (for
    // the ECS awsLogs driver → CloudWatch) and emitted through the
    // OTel logs API so the ADOT sidecar ships it to Grafana Loki.
    logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
    instrumentations: [
      getNodeAutoInstrumentations({
        // File-system noise isn't useful and blows up span volume.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // We own the http span surface in src/lib/http.ts; the generic
        // one double-counts outbound calls and hides attributes behind
        // the fetch wrapper. Inbound http is kept (Express needs it).
        '@opentelemetry/instrumentation-undici': { enabled: false },
      }),
    ],
  });

  sdk.start();
  initialized = true;

  // Graceful shutdown so in-flight spans flush before container exit.
  const shutdown = async (signal: string): Promise<void> => {
    try {
      await sdk?.shutdown();
    } catch {
      // Shutdown errors are terminal anyway.
    } finally {
      process.exit(signal === 'SIGINT' ? 130 : 0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Exposed for tests that want deterministic teardown. */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
  initialized = false;
}

export function getTracer(name = 'chorus'): Tracer {
  return trace.getTracer(name);
}

export function getMeter(name = 'chorus'): Meter {
  return metrics.getMeter(name);
}

export function getLogger(name = 'chorus'): Logger {
  return logs.getLogger(name);
}

export function isTelemetryActive(): boolean {
  return initialized;
}
