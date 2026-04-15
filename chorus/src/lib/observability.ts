import type { Request, Response, NextFunction } from 'express';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...meta }) + '\n',
  );
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
