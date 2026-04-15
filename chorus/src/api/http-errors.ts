import type { Response } from 'express';
import { logger } from '../lib/observability.js';

/**
 * Log an upstream failure and reply 502 with a uniform JSON body.
 * Use for failures where an external dependency (Linear, Bedrock,
 * Comprehend) is responsible — not for caller errors.
 */
export function sendBadGateway(
  res: Response,
  label: string,
  err: unknown,
  context: Record<string, unknown> = {},
): void {
  const detail = err instanceof Error ? err.message : String(err);
  logger.error(label, { ...context, error: detail });
  res.status(502).json({ error: label, detail });
}
