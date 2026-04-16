import type { Request, Response, NextFunction } from 'express';
import { SeverityNumber, type AnyValueMap } from '@opentelemetry/api-logs';
import { getLogger } from './telemetry.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

// Acquired lazily so the telemetry SDK has a chance to register its
// LoggerProvider (via `node --import ./telemetry-register.js`) before
// the first log line. When the SDK is inactive (OTEL_SDK_DISABLED=true
// or no collector wired) the API returns a no-op logger and `emit` is
// free.
let _otelLogger: ReturnType<typeof getLogger> | undefined;
function otelLogger(): ReturnType<typeof getLogger> {
  if (!_otelLogger) _otelLogger = getLogger('chorus');
  return _otelLogger;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  // Path 1 — stdout JSON → ECS awsLogs driver → CloudWatch.
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...meta }) + '\n',
  );
  // Path 2 — OTel log record → ADOT sidecar → Grafana Loki. Emission
  // is wrapped so a transient SDK error can never take down the
  // caller's request path; the CloudWatch line is already persisted.
  try {
    otelLogger().emit({
      severityNumber: SEVERITY[level],
      severityText: level.toUpperCase(),
      body: message,
      // OTel's AnyValueMap is a narrower structural type than
      // Record<string, unknown>. The exporter JSON-serialises values
      // at export time, so passing the raw meta through is safe —
      // any un-serialisable field (function, Symbol) degrades to
      // null at export, same as the stdout JSON.stringify path.
      ...(meta !== undefined ? { attributes: meta as AnyValueMap } : {}),
    });
  } catch {
    // swallow — log delivery best-effort on the Grafana side.
  }
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => log('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => log('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log('error', m, meta),
};

export interface CorrelatedRequest extends Request {
  correlationId?: string;
}

export function correlationMiddleware(
  req: CorrelatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers['x-chorus-correlation-id'];
  const id = (typeof header === 'string' ? header : undefined) ?? crypto.randomUUID();
  req.correlationId = id;
  res.setHeader('X-Chorus-Correlation-Id', id);
  next();
}

export async function withCorrelation<T>(
  correlationId: string,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  logger.debug(`${stage} start`, { correlationId });
  const r = await fn();
  logger.debug(`${stage} end`, { correlationId });
  return r;
}
