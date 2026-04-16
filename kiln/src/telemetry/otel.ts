/**
 * OpenTelemetry setup — OTLP exporter, structured JSON logs with trace correlation.
 * Must be imported before any other module in the entrypoint.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";

let sdk: NodeSDK | null = null;

export function initTelemetry(serviceName: string, version = "0.1.0"): void {
  sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: version,
    }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new HttpInstrumentation()],
  });

  sdk.start();
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}

/** Structured JSON logger — every line includes the active trace/span ID for correlation. */
export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const span = trace.getActiveSpan();
  const spanCtx = span?.spanContext();
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    traceId: spanCtx?.traceId ?? null,
    spanId: spanCtx?.spanId ?? null,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

/** Run fn inside a named span; records exceptions and re-throws. */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  const tracer = trace.getTracer("kiln");
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

export { context as otelContext };
