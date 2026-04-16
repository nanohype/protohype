import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'evals/**/*.test.ts', 'infra/**/*.test.ts'],
    environment: 'node',
    // OTEL_SDK_DISABLED keeps initTelemetry from registering exporters
    // during tests; the API-side no-op tracer/meter is what lib/http.ts
    // and lib/telemetry-hooks.ts pick up so span/metric calls are free.
    env: { OTEL_SDK_DISABLED: 'true' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
