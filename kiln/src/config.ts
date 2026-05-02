// Config — loaded once at startup, validated by zod, immutable thereafter.
// Every env var used by runtime code must pass through here. No other
// module is permitted to read process.env directly.

import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();
const positiveNumber = z.coerce.number().positive();
const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), {
  message: "must be an https:// URL",
});
const timeoutMs = z.coerce.number().int().min(100);

const schema = z.object({
  env: z.enum(["dev", "staging", "prod"]).default("dev"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  region: z.string().min(1).default("us-west-2"),

  // WorkOS AuthKit / User Management. Issuer + clientId drive JWT verification;
  // JWKS URL is derived from clientId unless explicitly overridden.
  workos: z.object({
    issuer: httpsUrl,
    clientId: z.string().min(1),
    jwksUrl: httpsUrl.optional(),
    teamClaim: z.string().min(1).default("kiln_team_id"),
    apiKey: z.string().min(1).optional(), // server-side WorkOS API calls; unused in v1
  }),

  tables: z.object({
    teamConfig: z.string().min(1),
    prLedger: z.string().min(1),
    auditLog: z.string().min(1),
    changelogCache: z.string().min(1),
    rateLimiter: z.string().min(1),
    githubTokenCache: z.string().min(1),
  }),

  upgradeQueueUrl: z.string().url(),

  github: z.object({
    appId: z.coerce.number().int().positive(),
    secretArn: z.string().min(1),
    rateCapacity: positiveNumber.default(4500),
    rateRefillPerSec: positiveNumber.default(1.25),
  }),

  bedrock: z.object({
    region: z.string().min(1).default("us-west-2"),
    classifierModel: z.string().min(1),
    synthesizerModel: z.string().min(1),
    synthesizerEscalationModel: z.string().min(1),
  }),

  timeouts: z.object({
    npmMs: timeoutMs.default(5_000),
    changelogMs: timeoutMs.default(10_000),
    githubMs: timeoutMs.default(15_000),
    bedrockMs: timeoutMs.default(30_000),
    secretsMs: timeoutMs.default(5_000),
  }),

  poller: z.object({
    intervalMinutes: positiveInt.default(15),
  }),

  // Grafana Cloud telemetry. OTel OTLP exporters send traces (Tempo),
  // metrics (Mimir), and logs (Loki) here. basic_auth lives in Secrets
  // Manager (see src/telemetry/init.ts); we only carry pointers.
  telemetry: z.object({
    enabled: z.coerce.boolean().default(false),
    serviceName: z.string().min(1).default("kiln"),
    otlpEndpoint: httpsUrl.optional(), // https://otlp-gateway-prod-<region>.grafana.net/otlp
    otlpSecretArn: z.string().min(1).optional(), // kiln/{env}/grafana-cloud/otlp-auth
    resourceAttributes: z.string().default(""), // e.g. "deployment.environment=prod,service.version=0.1.0"
    metricExportIntervalMs: timeoutMs.default(60_000),
  }),

  notifications: z.object({
    slackWebhookUrl: httpsUrl.optional(),
    linearApiKey: z.string().min(1).optional(),
  }),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = {
    env: env["KILN_ENV"],
    logLevel: env["KILN_LOG_LEVEL"],
    region: env["KILN_REGION"] ?? env["AWS_REGION"],
    workos: {
      issuer: env["KILN_WORKOS_ISSUER"],
      clientId: env["KILN_WORKOS_CLIENT_ID"],
      jwksUrl: env["KILN_WORKOS_JWKS_URL"] || undefined,
      teamClaim: env["KILN_WORKOS_TEAM_CLAIM"],
      apiKey: env["KILN_WORKOS_API_KEY"] || undefined,
    },
    tables: {
      teamConfig: env["KILN_TEAM_CONFIG_TABLE"],
      prLedger: env["KILN_PR_LEDGER_TABLE"],
      auditLog: env["KILN_AUDIT_LOG_TABLE"],
      changelogCache: env["KILN_CHANGELOG_CACHE_TABLE"],
      rateLimiter: env["KILN_RATE_LIMITER_TABLE"],
      githubTokenCache: env["KILN_GITHUB_TOKEN_CACHE_TABLE"],
    },
    upgradeQueueUrl: env["KILN_UPGRADE_QUEUE_URL"],
    github: {
      appId: env["KILN_GITHUB_APP_ID"],
      secretArn: env["KILN_GITHUB_APP_SECRET_ARN"],
      rateCapacity: env["KILN_GITHUB_RATE_CAPACITY"],
      rateRefillPerSec: env["KILN_GITHUB_RATE_REFILL_PER_SEC"],
    },
    bedrock: {
      region: env["KILN_BEDROCK_REGION"] ?? env["AWS_REGION"],
      classifierModel: env["KILN_BEDROCK_CLASSIFIER_MODEL"],
      synthesizerModel: env["KILN_BEDROCK_SYNTHESIZER_MODEL"],
      synthesizerEscalationModel: env["KILN_BEDROCK_SYNTHESIZER_ESCALATION_MODEL"],
    },
    timeouts: {
      npmMs: env["KILN_NPM_TIMEOUT_MS"],
      changelogMs: env["KILN_CHANGELOG_TIMEOUT_MS"],
      githubMs: env["KILN_GITHUB_TIMEOUT_MS"],
      bedrockMs: env["KILN_BEDROCK_TIMEOUT_MS"],
      secretsMs: env["KILN_SECRETS_TIMEOUT_MS"],
    },
    poller: {
      intervalMinutes: env["KILN_POLLER_INTERVAL_MINUTES"],
    },
    telemetry: {
      enabled: env["KILN_TELEMETRY_ENABLED"] ?? "false",
      serviceName: env["OTEL_SERVICE_NAME"] ?? "kiln",
      otlpEndpoint: env["OTEL_EXPORTER_OTLP_ENDPOINT"] || undefined,
      otlpSecretArn: env["KILN_GRAFANA_CLOUD_OTLP_SECRET_ARN"] || undefined,
      resourceAttributes: env["OTEL_RESOURCE_ATTRIBUTES"] ?? "",
      metricExportIntervalMs: env["OTEL_METRIC_EXPORT_INTERVAL"] ?? undefined,
    },
    notifications: {
      slackWebhookUrl: env["KILN_SLACK_WEBHOOK_URL"] || undefined,
      linearApiKey: env["KILN_LINEAR_API_KEY"] || undefined,
    },
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid kiln configuration:\n${issues}`);
  }
  return parsed.data;
}
