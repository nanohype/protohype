import { describe, expect, it } from "vitest";
import {
  parseClassifyOutput,
  parseSynthesizeOutput,
} from "../../../src/core/ai/guardrails.js";

describe("classify guardrail", () => {
  const valid = {
    breakingChanges: [
      {
        id: "remove-legacy-fn",
        title: "Remove legacyFn",
        severity: "breaking",
        description: "legacyFn was removed; migrate to newFn",
        affectedSymbols: ["legacyFn"],
        changelogUrl: "https://github.com/x/y/releases/tag/v2",
      },
    ],
    summary: "Breaking change in 2.0",
    confidence: 0.9,
  };

  it("accepts valid output", () => {
    expect(parseClassifyOutput(JSON.stringify(valid))).toEqual(valid);
  });

  it("tolerates Claude's ```json fences", () => {
    expect(parseClassifyOutput(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid);
  });

  it("rejects bad severity", () => {
    const bad = { ...valid, breakingChanges: [{ ...valid.breakingChanges[0], severity: "huge" }] };
    expect(() => parseClassifyOutput(JSON.stringify(bad))).toThrow();
  });

  it("rejects out-of-range confidence", () => {
    expect(() => parseClassifyOutput(JSON.stringify({ ...valid, confidence: 2 }))).toThrow();
  });
});

describe("synthesize guardrail", () => {
  it("accepts valid output", () => {
    const valid = {
      patches: [{ path: "src/x.ts", before: "a", after: "b", citations: ["https://..."] }],
      notes: "review carefully",
      warnings: [],
    };
    expect(parseSynthesizeOutput(JSON.stringify(valid))).toEqual(valid);
  });
});
