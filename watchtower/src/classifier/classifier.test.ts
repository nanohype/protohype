import { describe, it, expect } from "vitest";
import { createClassifier } from "./classifier.js";
import { createFakeLlm } from "./fake.js";
import { createLogger } from "../logger.js";
import type { RuleChange } from "../crawlers/types.js";
import type { ClientConfig } from "../clients/types.js";

const silent = createLogger("error", "classifier-test");

const change: RuleChange = {
  sourceId: "sec-edgar",
  contentHash: "rc-1",
  title: "Proposed Rule 15c3-1 amendment",
  url: "https://www.sec.gov/news/release/proposed",
  publishedAt: "2026-04-20T00:00:00Z",
  summary: "Enhanced intraday capital requirements",
  body: "Full text...",
  rawMetadata: {},
};

const client: ClientConfig = {
  clientId: "acme",
  name: "Acme Broker-Dealer",
  products: ["broker-dealer"],
  jurisdictions: ["US-federal"],
  frameworks: ["SEC-rule-15c3-1"],
  active: true,
};

function makeClassifier(llmText: string | Error, thresholds = { auto: 80, review: 50 }) {
  const llm =
    llmText instanceof Error
      ? createFakeLlm({ failWith: llmText })
      : createFakeLlm({ text: llmText });
  return createClassifier({
    llm,
    logger: silent,
    autoAlertThreshold: thresholds.auto,
    reviewThreshold: thresholds.review,
  });
}

describe("createClassifier — happy path", () => {
  it("routes score >= autoAlert to alert", async () => {
    const json = JSON.stringify({
      applicable: true,
      score: 90,
      confidence: "high",
      rationale: "direct hit on broker-dealer capital rules",
    });
    const result = await makeClassifier(json).classify({ change, client });
    expect(result.disposition).toBe("alert");
    expect(result.score).toBe(90);
    expect(result.failureMode).toBeUndefined();
  });

  it("routes review <= score < autoAlert to review", async () => {
    const json = JSON.stringify({
      applicable: true,
      score: 65,
      confidence: "medium",
      rationale: "adjacent topic",
    });
    const result = await makeClassifier(json).classify({ change, client });
    expect(result.disposition).toBe("review");
  });

  it("routes score < review to drop", async () => {
    const json = JSON.stringify({
      applicable: false,
      score: 20,
      confidence: "high",
      rationale: "wrong jurisdiction",
    });
    const result = await makeClassifier(json).classify({ change, client });
    expect(result.disposition).toBe("drop");
  });

  it("strips markdown code fences from the LLM response", async () => {
    const fenced =
      "```json\n" +
      JSON.stringify({
        applicable: true,
        score: 85,
        confidence: "high",
        rationale: "fenced",
      }) +
      "\n```";
    const result = await makeClassifier(fenced).classify({ change, client });
    expect(result.disposition).toBe("alert");
  });

  it("extracts JSON when surrounded by prose", async () => {
    const wrapped =
      "Sure! Here's the classification: " +
      JSON.stringify({ applicable: true, score: 55, confidence: "low", rationale: "x" }) +
      " Hope this helps.";
    const result = await makeClassifier(wrapped).classify({ change, client });
    expect(result.score).toBe(55);
  });
});

describe("createClassifier — fail-secure", () => {
  it("routes LLM timeout to review (failureMode=timeout)", async () => {
    const err = new Error("request aborted due to timeout");
    const result = await makeClassifier(err).classify({ change, client });
    expect(result.disposition).toBe("review");
    expect(result.failureMode).toBe("timeout");
    expect(result.score).toBe(50); // review threshold
    expect(result.rationale).toContain("classifier error");
  });

  it("routes LLM error to review (failureMode=llm-error)", async () => {
    const err = new Error("bedrock throttled");
    const result = await makeClassifier(err).classify({ change, client });
    expect(result.disposition).toBe("review");
    expect(result.failureMode).toBe("llm-error");
  });

  it("routes schema-invalid LLM response to review (failureMode=schema)", async () => {
    const bad = JSON.stringify({ applicable: "yes", score: 999 });
    const result = await makeClassifier(bad).classify({ change, client });
    expect(result.disposition).toBe("review");
    expect(result.failureMode).toBe("schema");
  });

  it("routes non-JSON LLM response to review", async () => {
    const result = await makeClassifier("totally not json").classify({ change, client });
    expect(result.disposition).toBe("review");
    expect(result.failureMode).toBe("schema");
  });

  it("never routes to drop when the LLM fails — even for an obviously-irrelevant client", async () => {
    const result = await makeClassifier(new Error("boom")).classify({
      change,
      client: {
        ...client,
        frameworks: ["GDPR"], // totally unrelated to SEC
        jurisdictions: ["EU"],
      },
    });
    expect(result.disposition).not.toBe("drop");
  });
});

describe("createClassifier — configuration", () => {
  it("rejects invalid threshold ordering at construction", () => {
    expect(() =>
      createClassifier({
        llm: createFakeLlm({ text: "{}" }),
        logger: silent,
        autoAlertThreshold: 40,
        reviewThreshold: 60,
      }),
    ).toThrow(/autoAlertThreshold/);
  });
});
