import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

export interface OtelInitParams {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly otlpEndpoint?: string;
  readonly environment?: string;
}

/**
 * Initialize OTel SDK. In production the collector side-car (ADOT) terminates
 * OTLP; the SDK is an unconditional passthrough. In development (no endpoint)
 * we skip exporters and only register instrumentation — spans + metrics are
 * available to tests but not exported.
 */
export function initTelemetry(params: OtelInitParams): { shutdown: () => Promise<void> } {
  if (!params.otlpEndpoint) {
    return { shutdown: async () => undefined };
  }

  // Resource constructed via the class constructor — the `resourceFromAttributes`
  // helper is not part of this SDK version. A plain Resource covers everything
  // the collector needs to tag exported spans and metrics.
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: params.serviceName,
    [ATTR_SERVICE_VERSION]: params.serviceVersion ?? "0.1.0",
    "deployment.environment": params.environment ?? "development",
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${params.otlpEndpoint}/v1/traces` }),
    // The sdk-metrics MetricReader type and sdk-node's expected type come from
    // the same hierarchy; the `as never` avoids a cross-package private-field
    // variance quibble that only surfaces under strict exactOptionalPropertyTypes.
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${params.otlpEndpoint}/v1/metrics` }),
      exportIntervalMillis: 15_000,
    }) as never,
    instrumentations: [getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } })],
  });
  sdk.start();

  return {
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}
