import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// ── Request-scoped correlation ───────────────────────────────────────
//
// Propagates a trace ID through async call chains so every log line
// emitted within a unit of work carries the same correlation ID. The
// logger reads from this store on every emit (no manual threading).
//
// Start a scope with `withTraceContext(fn)` — by default generates a
// fresh UUID, or pass an explicit ID (e.g. from a received SQS message
// attribute or OTel trace span) to thread it in from upstream.
//

export interface TraceContext {
  readonly traceId: string;
}

const store = new AsyncLocalStorage<TraceContext>();

/**
 * Run `fn` within a trace context. Nested calls see the outermost
 * trace ID — scope is not re-entered inside an existing scope.
 */
export function withTraceContext<T>(fn: () => T, traceId?: string): T {
  const existing = store.getStore();
  if (existing) return fn();
  return store.run({ traceId: traceId ?? randomUUID() }, fn);
}

/** Read the current trace ID, or `undefined` if outside a trace scope. */
export function currentTraceId(): string | undefined {
  return store.getStore()?.traceId;
}
