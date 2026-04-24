import type { DetectionLayerPort, MetricsPort, TracerPort } from "../ports/index.js";
import type { NormalizedPrompt } from "../types/prompt.js";
import type { LayerVerdict, PipelineVerdict } from "../types/verdict.js";
import { MetricNames } from "../metrics.js";
import { withTimeout } from "../util/with-timeout.js";
import type { Logger } from "../logger.js";

export interface PipelineDeps {
  readonly heuristics: DetectionLayerPort;
  readonly classifier: DetectionLayerPort;
  readonly corpusMatch: DetectionLayerPort;
  readonly timeouts: {
    readonly heuristicsMs: number;
    readonly classifierMs: number;
    readonly corpusMatchMs: number;
  };
  readonly metrics: MetricsPort;
  readonly tracer: TracerPort;
  readonly logger: Logger;
}

/**
 * Run the three detection layers in sequence with cascade logic:
 *   - heuristics BENIGN  → allow
 *   - heuristics MALICIOUS → block (heuristics)
 *   - heuristics UNCERTAIN → classifier
 *     - classifier BENIGN  → corpus-match  (last line of defense)
 *     - classifier MALICIOUS → block (classifier)
 *     - classifier UNCERTAIN → corpus-match
 *       - corpus-match ≥ threshold → block (corpus-match)
 *       - corpus-match < threshold → allow
 *
 * **Fail-secure**: any layer throwing or exceeding its timeout is treated
 * as a MALICIOUS verdict for that layer. Palisade's job is to not let bad
 * traffic through — an unavailable detector is not a pass.
 */
export function createDetectionPipeline(deps: PipelineDeps) {
  async function run(prompt: NormalizedPrompt): Promise<PipelineVerdict> {
    const start = Date.now();
    const layers: LayerVerdict[] = [];

    // Layer 1 — heuristics
    const heuristicsVerdict = await runLayer(deps.heuristics, prompt, deps.timeouts.heuristicsMs, deps);
    layers.push(heuristicsVerdict);
    if (heuristicsVerdict.outcome === "MALICIOUS") {
      return finalize("MALICIOUS", layers, "heuristics", start, deps);
    }
    if (heuristicsVerdict.outcome === "BENIGN") {
      return finalize("BENIGN", layers, undefined, start, deps);
    }

    // Layer 2 — classifier (invoked only on UNCERTAIN)
    const classifierVerdict = await runLayer(deps.classifier, prompt, deps.timeouts.classifierMs, deps);
    layers.push(classifierVerdict);
    if (classifierVerdict.outcome === "MALICIOUS") {
      return finalize("MALICIOUS", layers, "classifier", start, deps);
    }

    // Layer 3 — corpus-match (always runs if we got here)
    const corpusVerdict = await runLayer(deps.corpusMatch, prompt, deps.timeouts.corpusMatchMs, deps);
    layers.push(corpusVerdict);
    if (corpusVerdict.outcome === "MALICIOUS") {
      return finalize("MALICIOUS", layers, "corpus-match", start, deps);
    }

    return finalize("BENIGN", layers, undefined, start, deps);
  }

  return { run };
}

async function runLayer(
  layer: DetectionLayerPort,
  prompt: NormalizedPrompt,
  timeoutMs: number,
  deps: Pick<PipelineDeps, "metrics" | "tracer" | "logger">,
): Promise<LayerVerdict> {
  const layerStart = Date.now();
  try {
    return await deps.tracer.withSpan(
      `palisade.detect.${layer.name}`,
      { "palisade.layer": layer.name, "palisade.prompt_hash": prompt.promptHash },
      async (span) => {
        const verdict = await withTimeout(layer.detect(prompt), timeoutMs, `${layer.name} timeout after ${timeoutMs}ms`);
        // Attach post-detection attributes so traces carry the verdict shape.
        span.setAttribute("palisade.score", verdict.score);
        span.setAttribute("palisade.outcome", verdict.outcome);
        span.setAttribute("palisade.latency_ms", verdict.latencyMs);
        deps.metrics.histogram(MetricNames.LayerLatencyMs, verdict.latencyMs, { layer: layer.name, outcome: verdict.outcome });
        deps.metrics.counter(MetricNames.LayerOutcome, 1, { layer: layer.name, outcome: verdict.outcome });
        return verdict;
      },
    );
  } catch (err) {
    // Fail-secure — any error becomes a MALICIOUS layer verdict.
    const latencyMs = Date.now() - layerStart;
    deps.logger.error({ layer: layer.name, err }, "Detection layer failed — fail-secure BLOCK");
    deps.metrics.counter(MetricNames.LayerOutcome, 1, { layer: layer.name, outcome: "MALICIOUS", error: "true" });
    return {
      layer: layer.name,
      outcome: "MALICIOUS",
      score: 1,
      detail: { error: err instanceof Error ? err.message : String(err), failSecure: true },
      latencyMs,
    };
  }
}

function finalize(
  finalOutcome: "BENIGN" | "MALICIOUS",
  layers: LayerVerdict[],
  blockingLayer: PipelineVerdict["blockingLayer"] | undefined,
  start: number,
  deps: Pick<PipelineDeps, "metrics">,
): PipelineVerdict {
  const totalLatencyMs = Date.now() - start;
  if (finalOutcome === "MALICIOUS") {
    deps.metrics.counter(MetricNames.DetectionBlocked, 1, { blocking_layer: blockingLayer ?? "unknown" });
  } else {
    deps.metrics.counter(MetricNames.DetectionAllowed, 1);
  }
  const verdict: PipelineVerdict = {
    finalOutcome,
    layers,
    totalLatencyMs,
    ...(blockingLayer ? { blockingLayer } : {}),
  };
  return verdict;
}
