import { describe, it, expect } from "vitest";
import { loadConfig } from "./index.js";

// Spawning a child process isn't worth it — we test loadConfig in
// isolation by feeding it a known `source` object and asserting the
// shape of what we get back. `process.exit(1)` never fires because
// we supply valid input; the validation-failure path is verified by
// scanning stderr in an integration test later (not in scope for v0).

const baseValid = {
  CLIENTS_TABLE: "t",
  DEDUP_TABLE: "t",
  MEMOS_TABLE: "t",
  AUDIT_TABLE: "t",
  AUDIT_BUCKET: "b",
  CRAWL_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/1/crawl",
  CLASSIFY_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/1/classify",
  PUBLISH_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/1/publish",
  AUDIT_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/1/audit",
  CORPUS_HOST: "localhost",
  CORPUS_DATABASE: "watchtower_test",
  CORPUS_USER: "postgres",
  CORPUS_PASSWORD: "x",
  ENVELOPE_KMS_KEY_ID: "arn:aws:kms:us-west-2:1:key/0",
  STATE_SIGNING_SECRET: "a".repeat(64),
};

describe("loadConfig", () => {
  it("accepts a minimal valid env and fills defaults", () => {
    const config = loadConfig(baseValid as NodeJS.ProcessEnv);
    expect(config.env.AWS_REGION).toBe("us-west-2");
    expect(config.env.NODE_ENV).toBe("production");
    expect(config.env.LOG_LEVEL).toBe("info");
    expect(config.env.HEALTH_PORT).toBe(9090);
    expect(config.bedrockRegion).toBe("us-west-2");
    expect(config.isProd).toBe(true);
  });

  it("honors explicit BEDROCK_REGION overriding AWS_REGION", () => {
    const config = loadConfig({
      ...baseValid,
      AWS_REGION: "us-east-1",
      BEDROCK_REGION: "us-west-2",
    } as NodeJS.ProcessEnv);
    expect(config.bedrockRegion).toBe("us-west-2");
    expect(config.env.AWS_REGION).toBe("us-east-1");
  });

  it("derives isProd from NODE_ENV", () => {
    const staging = loadConfig({ ...baseValid, NODE_ENV: "staging" } as NodeJS.ProcessEnv);
    expect(staging.isProd).toBe(false);
    const prod = loadConfig({ ...baseValid, NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(prod.isProd).toBe(true);
  });

  it("accepts classifier thresholds as numeric strings", () => {
    const config = loadConfig({
      ...baseValid,
      APPLICABILITY_AUTO_ALERT_THRESHOLD: "85",
      APPLICABILITY_REVIEW_THRESHOLD: "40",
    } as NodeJS.ProcessEnv);
    expect(config.env.APPLICABILITY_AUTO_ALERT_THRESHOLD).toBe(85);
    expect(config.env.APPLICABILITY_REVIEW_THRESHOLD).toBe(40);
  });
});
