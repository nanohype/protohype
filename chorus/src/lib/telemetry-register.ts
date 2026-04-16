/**
 * Loaded via `node --import ./dist/src/lib/telemetry-register.js <entrypoint>`.
 * Running at module-load time guarantees the SDK installs its hooks
 * before the entrypoint imports http/express/pg — which is the only
 * way the auto-instrumentations can patch those modules.
 *
 * The service name comes from `OTEL_SERVICE_NAME` (set per-container
 * in the CDK stack). If unset, initTelemetry falls back to the
 * `chorus-unknown` label so an un-configured container is still
 * obvious in the trace view.
 */
import { initTelemetry } from './telemetry.js';

initTelemetry({
  serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'chorus-unknown',
});
