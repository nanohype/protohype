import type { ClassifierPort, ClassifierVerdict } from "../../ports/index.js";
import type { NormalizedPrompt } from "../../types/prompt.js";

/**
 * In-process deterministic classifier — used in tests and in dev when
 * PALISADE_USE_FAKES=true. Returns a score derived from simple keyword
 * presence so pipeline behavior is fully exercisable without Bedrock.
 */
export function createFakeClassifier(scorer: (p: NormalizedPrompt) => number = defaultScorer): ClassifierPort {
  return {
    async classify(prompt: NormalizedPrompt): Promise<ClassifierVerdict> {
      const score = Math.max(0, Math.min(1, scorer(prompt)));
      const result: ClassifierVerdict = {
        score,
        ...(score > 0.7 ? { label: "suspicious" } : {}),
      };
      return result;
    },
  };
}

function defaultScorer(prompt: NormalizedPrompt): number {
  const t = prompt.text.toLowerCase();
  let score = 0.1;
  if (t.includes("ignore") && t.includes("instructions")) score += 0.5;
  if (t.includes("system prompt")) score += 0.3;
  if (t.includes("jailbreak") || t.includes("dan")) score += 0.4;
  return score;
}
