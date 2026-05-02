// Dual-sink structured logger.
//
// Every log line is emitted in two places:
//   1. stderr as JSON — keeps CloudWatch as a backup destination, makes local
//      dev grep-friendly.
//   2. OTel Logs API — when telemetry is active, log records flow via the
//      OTLP Logs exporter to Grafana Cloud Loki. When telemetry is off, the
//      no-op provider discards them cheaply.
//
// stdout is reserved for protocol / CLI output.

import { logs, SeverityNumber, type LogRecord } from "@opentelemetry/api-logs";
import { trace } from "@opentelemetry/api";
import type { LoggerPort } from "./core/ports.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const otelSeverity: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

const LOGGER_NAME = "kiln";

export interface LoggerOptions {
  level: LogLevel;
  service: string;
  bindings?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions): LoggerPort {
  const minLevel = levelOrder[opts.level];
  const bindings = opts.bindings ?? {};
  const otelLogger = logs.getLogger(LOGGER_NAME);

  const emit = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (levelOrder[level] < minLevel) return;

    const activeSpan = trace.getActiveSpan();
    const spanContext = activeSpan?.spanContext();
    const traceBindings: Record<string, unknown> =
      spanContext && spanContext.traceId !== "00000000000000000000000000000000"
        ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
        : {};

    const payload = {
      ts: new Date().toISOString(),
      level,
      service: opts.service,
      message,
      ...bindings,
      ...traceBindings,
      ...meta,
    };

    // stderr sink
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(payload));

    // OTel Logs sink — no-ops until telemetry is initialized.
    const record: LogRecord = {
      severityNumber: otelSeverity[level],
      severityText: level.toUpperCase(),
      body: message,
      attributes: {
        "service.name": opts.service,
        ...flatten(bindings),
        ...flatten(meta ?? {}),
      },
    };
    otelLogger.emit(record);
  };

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
    child: (extra) =>
      createLogger({
        level: opts.level,
        service: opts.service,
        bindings: { ...bindings, ...extra },
      }),
  };
}

/** OTel log attributes must be flat primitives. Stringify non-scalars. */
function flatten(obj: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}
