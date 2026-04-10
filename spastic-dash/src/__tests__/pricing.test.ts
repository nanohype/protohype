import { describe, it, expect } from "vitest";
import { computeCost, getPricing, modelLabel } from "../pricing.js";

describe("getPricing", () => {
  it("returns sonnet pricing for exact model name", () => {
    const p = getPricing("claude-sonnet-4-5");
    expect(p.inputPerM).toBe(3.0);
    expect(p.outputPerM).toBe(15.0);
  });

  it("returns opus pricing for exact model name", () => {
    const p = getPricing("claude-opus-4-5");
    expect(p.inputPerM).toBe(15.0);
    expect(p.outputPerM).toBe(75.0);
  });

  it("fuzzy-matches opus from model string containing 'opus'", () => {
    const p = getPricing("us.anthropic.claude-opus-4-20250514-v1:0");
    expect(p.inputPerM).toBe(15.0);
  });

  it("falls back to sonnet pricing for unknown model", () => {
    const p = getPricing("claude-unknown-model");
    expect(p.inputPerM).toBe(3.0);
  });
});

describe("computeCost", () => {
  it("computes zero cost for zero tokens", () => {
    expect(computeCost("claude-sonnet-4-5", 0, 0)).toBe(0);
  });

  it("computes correct cost for 1M input tokens (sonnet)", () => {
    // $3/M input = $3 for 1M tokens
    const cost = computeCost("claude-sonnet-4-5", 1_000_000, 0);
    expect(cost).toBeCloseTo(3.0, 4);
  });

  it("computes correct cost for 1M output tokens (sonnet)", () => {
    const cost = computeCost("claude-sonnet-4-5", 0, 1_000_000);
    expect(cost).toBeCloseTo(15.0, 4);
  });

  it("computes correct cost for 1M output tokens (opus)", () => {
    const cost = computeCost("claude-opus-4-5", 0, 1_000_000);
    expect(cost).toBeCloseTo(75.0, 4);
  });

  it("includes cache read and write costs", () => {
    // Sonnet: cache read $0.30/M, cache write $3.75/M
    const cost = computeCost("claude-sonnet-4-5", 0, 0, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.30 + 3.75, 4);
  });

  it("computes combined cost correctly", () => {
    // 10k input @ $3/M = $0.03
    // 2k output @ $15/M = $0.03
    const cost = computeCost("claude-sonnet-4-5", 10_000, 2_000);
    expect(cost).toBeCloseTo(0.03 + 0.03, 5);
  });
});

describe("modelLabel", () => {
  it("labels sonnet models correctly", () => {
    expect(modelLabel("claude-sonnet-4-5")).toBe("sonnet");
    expect(modelLabel("claude-3-5-sonnet-20241022")).toBe("sonnet");
  });

  it("labels opus models correctly", () => {
    expect(modelLabel("claude-opus-4-5")).toBe("opus");
  });

  it("labels haiku models correctly", () => {
    expect(modelLabel("claude-haiku-3-5")).toBe("haiku");
  });

  it("defaults to sonnet for unknown", () => {
    expect(modelLabel("claude-unknown")).toBe("sonnet");
  });
});
