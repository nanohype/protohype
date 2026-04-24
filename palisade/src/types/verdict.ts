export type LayerName = "heuristics" | "classifier" | "corpus-match";

/**
 * Per-layer outcome. UNCERTAIN cascades to the next layer; BENIGN short-circuits
 * (allow), MALICIOUS short-circuits (block).
 */
export type LayerOutcome = "BENIGN" | "UNCERTAIN" | "MALICIOUS";

export interface LayerVerdict {
  readonly layer: LayerName;
  readonly outcome: LayerOutcome;
  /** 0..1 — the layer's confidence in the outcome. */
  readonly score: number;
  /** Layer-specific structured detail (never returned to the caller; logged to audit). */
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Latency of this layer in ms — recorded as span attribute + histogram. */
  readonly latencyMs: number;
}

/**
 * Aggregate pipeline verdict after the three layers.
 */
export interface PipelineVerdict {
  readonly finalOutcome: "BENIGN" | "MALICIOUS";
  readonly blockingLayer?: LayerName;
  readonly layers: ReadonlyArray<LayerVerdict>;
  readonly totalLatencyMs: number;
}
