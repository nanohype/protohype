/**
 * Anthropic model pricing constants.
 * Update these when Anthropic changes pricing — or override via env vars.
 */

export interface ModelPricing {
  inputPerM: number;      // $ per million input tokens
  outputPerM: number;     // $ per million output tokens
  cacheReadPerM: number;  // $ per million cache-read tokens
  cacheWritePerM: number; // $ per million cache-write tokens
}

export const PRICING: Record<string, ModelPricing> = {
  // Claude Sonnet 4.6
  "claude-sonnet-4-6": { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.30, cacheWritePerM: 3.75 },

  // Claude Opus 4.6
  "claude-opus-4-6": { inputPerM: 15.0, outputPerM: 75.0, cacheReadPerM: 1.50, cacheWritePerM: 18.75 },

  // Claude Sonnet 4.5
  "claude-sonnet-4-5": { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.30, cacheWritePerM: 3.75 },
  "claude-3-5-sonnet-20241022": { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.30, cacheWritePerM: 3.75 },
  "claude-3-5-sonnet-20240620": { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.30, cacheWritePerM: 3.75 },

  // Claude Opus 4.5
  "claude-opus-4-5": { inputPerM: 15.0, outputPerM: 75.0, cacheReadPerM: 1.50, cacheWritePerM: 18.75 },
  "claude-3-opus-20240229": { inputPerM: 15.0, outputPerM: 75.0, cacheReadPerM: 1.50, cacheWritePerM: 18.75 },

  // Claude Haiku 3.5
  "claude-haiku-3-5": { inputPerM: 0.80, outputPerM: 4.0, cacheReadPerM: 0.08, cacheWritePerM: 1.00 },
  "claude-3-5-haiku-20241022": { inputPerM: 0.80, outputPerM: 4.0, cacheReadPerM: 0.08, cacheWritePerM: 1.00 },
  "claude-3-haiku-20240307": { inputPerM: 0.25, outputPerM: 1.25, cacheReadPerM: 0.03, cacheWritePerM: 0.30 },
};

/** Fallback pricing when model is unknown — use Sonnet rates as a safe estimate */
const FALLBACK_PRICING: ModelPricing = { inputPerM: 3.0, outputPerM: 15.0, cacheReadPerM: 0.30, cacheWritePerM: 3.75 };

export function getPricing(model: string): ModelPricing {
  // Exact match first
  if (PRICING[model]) return PRICING[model];

  // Fuzzy: match by prefix/contains
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return PRICING["claude-opus-4-5"];
  if (lower.includes("haiku")) return PRICING["claude-haiku-3-5"];
  if (lower.includes("sonnet")) return PRICING["claude-sonnet-4-5"];

  return FALLBACK_PRICING;
}

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): number {
  const p = getPricing(model);
  return (
    (inputTokens / 1_000_000) * p.inputPerM +
    (outputTokens / 1_000_000) * p.outputPerM +
    (cacheReadTokens / 1_000_000) * p.cacheReadPerM +
    (cacheWriteTokens / 1_000_000) * p.cacheWritePerM
  );
}

/** Canonical model display name for UI */
export function modelLabel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  return "sonnet";
}
