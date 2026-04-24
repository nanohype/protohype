import { pino, type Logger as PinoLogger } from "pino";

export interface LogContext {
  traceId?: string;
  attemptId?: string;
  identity?: string;
  [key: string]: unknown;
}

export type Logger = PinoLogger;

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "palisade" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
