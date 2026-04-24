import { trace, metrics, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import type { MetricsPort, TracerPort } from "../ports/index.js";

/**
 * Thin facade binding the @opentelemetry/api to our narrow ports. Keeps
 * every call site free of OTel-specific imports, which makes swapping
 * exporters or mocking tracing trivial.
 */
export function createOtelFacade(serviceName: string): { tracer: TracerPort; metrics: MetricsPort } {
  const tracer = trace.getTracer(serviceName);
  const meter = metrics.getMeter(serviceName);

  const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
  const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();

  function counterFor(name: string) {
    let c = counters.get(name);
    if (!c) {
      c = meter.createCounter(name);
      counters.set(name, c);
    }
    return c;
  }

  function histogramFor(name: string) {
    let h = histograms.get(name);
    if (!h) {
      h = meter.createHistogram(name);
      histograms.set(name, h);
    }
    return h;
  }

  const metricsPort: MetricsPort = {
    counter: (name, value = 1, attributes) => counterFor(name).add(value, attributes as Attributes | undefined),
    histogram: (name, value, attributes) => histogramFor(name).record(value, attributes as Attributes | undefined),
  };

  const tracerPort: TracerPort = {
    withSpan: async (name, attributes, fn) => {
      return tracer.startActiveSpan(name, { attributes: attributes as Attributes }, async (span) => {
        try {
          const result = await fn({
            setAttribute: (key, value) => {
              span.setAttribute(key, value);
            },
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      });
    },
  };

  return { tracer: tracerPort, metrics: metricsPort };
}
