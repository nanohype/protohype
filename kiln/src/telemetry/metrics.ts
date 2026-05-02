// MetricsEmitter — kiln metrics via the OTel Metrics API.
//
// Exports via OTLP to Grafana Cloud Mimir; started programmatically in
// src/telemetry/init.ts so the basic_auth credential stays inside Secrets
// Manager rather than the Lambda env map.
//
// Counters → monotonic counts (e.g., breaking_change_classified_count).
// Histograms → distributions (e.g., classify_duration_ms) so Mimir surfaces
// p50/p99 without pre-aggregation in the app.
//
// All emission is non-blocking. The SDK buffers and batches; errors go to
// the SDK's own diag logger instead of blocking callers.

import { metrics as otelMetrics, type Counter, type Histogram } from "@opentelemetry/api";

const METER_NAME = "kiln";

export type MetricDimension = { name: string; value: string };

function toAttributes(dims: MetricDimension[]): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const d of dims) attrs[d.name] = d.value;
  return attrs;
}

export class MetricsEmitter {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  /** Increment a monotonic counter by 1. */
  increment(metricName: string, dimensions: MetricDimension[] = []): void {
    this.getCounter(metricName).add(1, toAttributes(dimensions));
  }

  /** Add an arbitrary value to a counter. */
  count(metricName: string, value: number, dimensions: MetricDimension[] = []): void {
    this.getCounter(metricName).add(value, toAttributes(dimensions));
  }

  /** Record a duration in milliseconds. Routes to a histogram. */
  durationMs(metricName: string, ms: number, dimensions: MetricDimension[] = []): void {
    this.getHistogram(metricName).record(ms, toAttributes(dimensions));
  }

  /** Record an arbitrary distribution sample. */
  distribution(metricName: string, value: number, dimensions: MetricDimension[] = []): void {
    this.getHistogram(metricName).record(value, toAttributes(dimensions));
  }

  private getCounter(name: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = otelMetrics.getMeter(METER_NAME).createCounter(name);
      this.counters.set(name, c);
    }
    return c;
  }

  private getHistogram(name: string): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = otelMetrics.getMeter(METER_NAME).createHistogram(name, { unit: "ms" });
      this.histograms.set(name, h);
    }
    return h;
  }
}

/** Canonical metric names. Keep in sync with Grafana dashboard panels + alerting rules. */
export const MetricNames = {
  // Pipeline stages
  ClassifyDurationMs: "kiln_classify_duration_ms",
  SynthesizeDurationMs: "kiln_synthesize_duration_ms",
  CodeSearchDurationMs: "kiln_code_search_duration_ms",
  ChangelogFetchDurationMs: "kiln_changelog_fetch_duration_ms",
  PrOpenDurationMs: "kiln_pr_open_duration_ms",
  UpgraderTotalDurationMs: "kiln_upgrader_total_duration_ms",

  // Outcomes (counters with outcome dimension)
  PrOpenedCount: "kiln_pr_opened_count",
  UpgradeSkippedCount: "kiln_upgrade_skipped_count",
  UpgradeFailedCount: "kiln_upgrade_failed_count",
  LedgerDesyncCount: "kiln_ledger_desync_count",

  // Classification output
  BreakingChangeClassifiedCount: "kiln_breaking_change_classified_count",
  ClassifierEscalationCount: "kiln_classifier_escalation_count", // synth escalated to Opus

  // Back-pressure + reliability
  RateLimiterRejectCount: "kiln_rate_limiter_reject_count",
  BedrockThrottleCount: "kiln_bedrock_throttle_count",
  GithubThrottleCount: "kiln_github_throttle_count",
  HttpTimeoutCount: "kiln_http_timeout_count",
  HttpErrorCount: "kiln_http_error_count",

  // Poller
  PollerEnqueuedCount: "kiln_poller_enqueued_count",
  PollerScannedCount: "kiln_poller_scanned_count",
  PollerCycleDurationMs: "kiln_poller_cycle_duration_ms",
} as const;

/** Module-scope singleton so adapters and workers share one instance. */
export const metrics = new MetricsEmitter();
