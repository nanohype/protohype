import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const validEnv = {
  KILN_ENV: "dev",
  KILN_LOG_LEVEL: "info",
  KILN_REGION: "us-west-2",
  KILN_WORKOS_ISSUER: "https://api.workos.com",
  KILN_WORKOS_CLIENT_ID: "client_abc123",
  KILN_WORKOS_TEAM_CLAIM: "kiln_team_id",
  KILN_TEAM_CONFIG_TABLE: "t1",
  KILN_PR_LEDGER_TABLE: "t2",
  KILN_AUDIT_LOG_TABLE: "t3",
  KILN_CHANGELOG_CACHE_TABLE: "t4",
  KILN_RATE_LIMITER_TABLE: "t5",
  KILN_GITHUB_TOKEN_CACHE_TABLE: "t6",
  KILN_UPGRADE_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/1/q.fifo",
  KILN_GITHUB_APP_ID: "123",
  KILN_GITHUB_APP_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:1:secret:x",
  KILN_BEDROCK_REGION: "us-west-2",
  KILN_BEDROCK_CLASSIFIER_MODEL: "anthropic.claude-haiku-4-5",
  KILN_BEDROCK_SYNTHESIZER_MODEL: "anthropic.claude-sonnet-4-6",
  KILN_BEDROCK_SYNTHESIZER_ESCALATION_MODEL: "anthropic.claude-opus-4-6",
};

describe("loadConfig", () => {
  it("accepts a valid environment", () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.env).toBe("dev");
    expect(cfg.workos.clientId).toBe("client_abc123");
    expect(cfg.timeouts.bedrockMs).toBe(30_000); // default
    expect(cfg.telemetry.enabled).toBe(false); // default off
  });

  it("rejects missing required fields with a useful error", () => {
    const { KILN_WORKOS_ISSUER: _, ...partial } = validEnv;
    expect(() => loadConfig(partial)).toThrow(/workos\.issuer/);
  });

  it("rejects malformed URL", () => {
    expect(() => loadConfig({ ...validEnv, KILN_WORKOS_ISSUER: "not-a-url" })).toThrow();
  });

  it("rejects http:// URLs (https only)", () => {
    expect(() =>
      loadConfig({ ...validEnv, KILN_WORKOS_ISSUER: "http://api.workos.com" }),
    ).toThrow(/https/);
  });

  it("rejects sub-100ms timeouts", () => {
    expect(() => loadConfig({ ...validEnv, KILN_SECRETS_TIMEOUT_MS: "50" })).toThrow();
  });
});
