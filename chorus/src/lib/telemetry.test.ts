import { describe, it, expect } from 'vitest';
import { trace, metrics } from '@opentelemetry/api';
import {
  initTelemetry,
  isTelemetryActive,
  getMeter,
  getTracer,
  shutdownTelemetry,
} from './telemetry.js';

describe('telemetry', () => {
  it('initTelemetry is a no-op when OTEL_SDK_DISABLED=true', () => {
    // vitest.config.ts sets this for the whole suite.
    expect(process.env['OTEL_SDK_DISABLED']).toBe('true');
    initTelemetry({ serviceName: 'chorus-test' });
    expect(isTelemetryActive()).toBe(false);
  });

  it('getTracer returns the OTel API tracer (no-op when SDK inactive)', () => {
    const t = getTracer('chorus.http');
    expect(t).toBeDefined();
    // The API-side tracer is always present; when no SDK is registered
    // it returns no-op spans which silently ignore attribute calls.
    const span = t.startSpan('smoke');
    span.setAttribute('k', 'v');
    span.end();
  });

  it('getMeter returns the OTel API meter; metric instruments accept calls', () => {
    const m = getMeter('chorus.smoke');
    const c = m.createCounter('chorus.smoke.events');
    c.add(1, { source: 'unit-test' });
    // No assertion against the meter state — the API is deliberately
    // opaque so the SDK can be swapped out. Reaching this line without
    // throwing is the contract.
    expect(trace).toBeDefined();
    expect(metrics).toBeDefined();
  });

  it('shutdownTelemetry is safe to call when no SDK was started', async () => {
    await shutdownTelemetry();
  });
});
