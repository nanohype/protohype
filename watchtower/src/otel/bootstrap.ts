// ── OTel SDK Bootstrap ──────────────────────────────────────────────
//
// Auto-instrumentation loads via the Dockerfile's NODE_OPTIONS flag
// (`--require @opentelemetry/auto-instrumentations-node/register`) so
// http/fetch/aws-sdk/pg spans are captured before any user code runs.
// This module wires additional service-level resource attributes and
// exposes a safe shutdown hook the entry point can call on SIGTERM.
//
// The ADOT collector sidecar (provisioned by the CDK stack) listens on
// localhost:4317 (gRPC) and localhost:4318 (HTTP). Any OTLP exporter
// picked up by the auto-instrumentation env vars writes there.
//

import { metrics, trace, type Tracer, type Meter } from "@opentelemetry/api";

/** Environment-supplied attributes that get attached to every span. */
export interface TelemetryConfig {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
  readonly region: string;
}

let configured = false;

/**
 * Record watchtower's service identity on the OTel resource. Must be
 * called before any span or metric is emitted; `src/index.ts` does
 * this once before constructing downstream clients.
 */
export function initTelemetry(config: TelemetryConfig): { tracer: Tracer; meter: Meter } {
  if (configured) {
    return {
      tracer: trace.getTracer(config.serviceName),
      meter: metrics.getMeter(config.serviceName),
    };
  }
  // The auto-instrumentation SDK reads resource attributes from the
  // `OTEL_RESOURCE_ATTRIBUTES` env var. Set before the SDK initializes
  // (i.e. before the --require hook) to have it include these on every
  // span. For completeness we also record them in the service tracer /
  // meter so in-process consumers can inspect them.
  const attributes = [
    `service.name=${config.serviceName}`,
    `service.version=${config.serviceVersion}`,
    `deployment.environment=${config.environment}`,
    `cloud.provider=aws`,
    `cloud.region=${config.region}`,
  ].join(",");
  // Merge rather than overwrite — ECS Fargate + task-def env already
  // set OTEL_RESOURCE_ATTRIBUTES with the sidecar's defaults.
  if (process.env.OTEL_RESOURCE_ATTRIBUTES) {
    process.env.OTEL_RESOURCE_ATTRIBUTES = `${process.env.OTEL_RESOURCE_ATTRIBUTES},${attributes}`;
  } else {
    process.env.OTEL_RESOURCE_ATTRIBUTES = attributes;
  }
  configured = true;
  return {
    tracer: trace.getTracer(config.serviceName, config.serviceVersion),
    meter: metrics.getMeter(config.serviceName, config.serviceVersion),
  };
}

/** Reset the module-level initialization flag — test-only. */
export function _resetForTests(): void {
  configured = false;
}
