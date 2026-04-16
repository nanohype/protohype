import { SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
import { getMeter, getTracer } from './telemetry.js';

const meter = getMeter('chorus');

/** Pipeline stage counter — one increment per stage completion. */
const pipelineStageDuration = meter.createHistogram('chorus.pipeline.stage.duration', {
  description: 'Milliseconds spent in each pipeline stage',
  unit: 'ms',
});
const pipelineStageErrors = meter.createCounter('chorus.pipeline.stage.errors', {
  description: 'Count of pipeline stage failures',
});

/** External HTTP call breaker-state gauge — label per baseUrl. */
const breakerState = meter.createObservableGauge('chorus.http.breaker.state', {
  description: '0=CLOSED, 1=HALF_OPEN, 2=OPEN',
});
const breakerStateByHost = new Map<string, 0 | 1 | 2>();
breakerState.addCallback((result) => {
  for (const [host, state] of breakerStateByHost) {
    result.observe(state, { 'chorus.host': host });
  }
});

/** Per-source ingestion counter. */
const ingestCount = meter.createCounter('chorus.ingest.items', {
  description: 'Feedback items ingested by source',
});

/** Per-decision proposal counter. */
const proposalDecisions = meter.createCounter('chorus.proposals.decisions', {
  description: 'Proposal outcomes: LINK / NEW / APPROVED / REJECTED / DEFERRED',
});

/**
 * Wrap an async function in a span. The span ends with either OK
 * status on resolve or ERROR + recorded exception on throw. Returns
 * the wrapped function's result so callers can `await withSpan(...)`.
 */
export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function recordPipelineStage(stage: string, durationMs: number, success: boolean): void {
  pipelineStageDuration.record(durationMs, { 'chorus.stage': stage });
  if (!success) pipelineStageErrors.add(1, { 'chorus.stage': stage });
}

export function setBreakerState(host: string, state: 'CLOSED' | 'HALF_OPEN' | 'OPEN'): void {
  const v = state === 'CLOSED' ? 0 : state === 'HALF_OPEN' ? 1 : 2;
  breakerStateByHost.set(host, v);
}

export function recordIngestItem(source: string): void {
  ingestCount.add(1, { 'chorus.source': source });
}

export function recordProposalDecision(decision: string): void {
  proposalDecisions.add(1, { 'chorus.decision': decision });
}
