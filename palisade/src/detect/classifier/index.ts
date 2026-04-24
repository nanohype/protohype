import type { ClassifierPort, DetectionLayerPort } from "../../ports/index.js";
import type { LayerVerdict } from "../../types/verdict.js";
import type { NormalizedPrompt } from "../../types/prompt.js";

export interface ClassifierLayerConfig {
  readonly blockThreshold: number;
  readonly allowThreshold: number;
}

/**
 * Classifier detection layer. Thin adapter around a `ClassifierPort` that
 * converts the raw score into a three-valued outcome. No fallback — if the
 * port throws, the pipeline's fail-secure wrapper takes over.
 */
export function createClassifierLayer(classifier: ClassifierPort, config: ClassifierLayerConfig): DetectionLayerPort {
  return {
    name: "classifier" as const,
    async detect(prompt: NormalizedPrompt): Promise<LayerVerdict> {
      const start = Date.now();
      const verdict = await classifier.classify(prompt);
      const outcome: LayerVerdict["outcome"] =
        verdict.score >= config.blockThreshold ? "MALICIOUS" : verdict.score < config.allowThreshold ? "BENIGN" : "UNCERTAIN";
      return {
        layer: "classifier",
        outcome,
        score: verdict.score,
        detail: verdict.label ? { label: verdict.label } : {},
        latencyMs: Date.now() - start,
      };
    },
  };
}
