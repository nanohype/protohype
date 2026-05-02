// OTel tracing helpers.
//
// Auto-instrumentation (started in src/telemetry/init.ts) traces http / fetch /
// aws-sdk automatically. This module adds:
//   - `withSpan` wrapper for business-logic milestones (records exception +
//     error status, end() in finally)
//   - SQS MessageAttributes ↔ W3C trace-context helpers so traces cross the
//     poller → SQS → worker hop
//
// The tracer name identifies this instrumentation library in Grafana Cloud
// Tempo, so dashboards can filter by `library=kiln`.

import type { MessageAttributeValue as SqsMessageAttributeValue } from "@aws-sdk/client-sqs";
import { context, propagation, SpanStatusCode, trace, type Span } from "@opentelemetry/api";

const TRACER_NAME = "kiln";

export const tracer = trace.getTracer(TRACER_NAME);

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw e;
    } finally {
      span.end();
    }
  });
}

/**
 * Inject the active trace context into an SQS MessageAttributes map. Call at
 * the send site so the worker can continue the trace.
 */
export function injectSqsTraceAttributes(
  baseAttributes: Record<string, SqsMessageAttributeValue> = {},
): Record<string, SqsMessageAttributeValue> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const out: Record<string, SqsMessageAttributeValue> = { ...baseAttributes };
  for (const [key, value] of Object.entries(carrier)) {
    if (value) out[key] = { DataType: "String", StringValue: value };
  }
  return out;
}

/**
 * Extract trace context from SQS MessageAttributes into an OTel context.
 * Returns the parent context for `context.with(parent, handler)`.
 */
export function extractSqsTraceContext(
  messageAttributes: Record<string, SqsMessageAttributeValue> | undefined,
): ReturnType<typeof propagation.extract> {
  const carrier: Record<string, string> = {};
  if (messageAttributes) {
    for (const [k, v] of Object.entries(messageAttributes)) {
      if (v?.StringValue) carrier[k] = v.StringValue;
    }
  }
  return propagation.extract(context.active(), carrier);
}

export { context, trace };
