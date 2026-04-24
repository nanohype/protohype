import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────
//
// Every environment variable watchtower reads is declared and
// validated here. The `Config` type is the single source of truth —
// adopters should read from the returned object, never from
// `process.env` directly. Missing or invalid values fail fast on
// startup with per-field error messages.
//
// Defaults prefer correctness over ambition: pollers are conservative
// (2–5 concurrency), classifier and memo models default to Claude
// Sonnet 4.6 via a cross-region inference profile, region falls back
// to us-west-2 per the global rule.
//

const numeric = (def: string) => z.string().default(def).transform(Number).pipe(z.number().int());

const configSchema = z.object({
  // ── Runtime ──────────────────────────────────────────────────────
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("production"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  HEALTH_PORT: numeric("9090").pipe(z.number().int().min(1).max(65535)),
  SHUTDOWN_TIMEOUT_MS: numeric("30000").pipe(z.number().int().min(1000)),

  // ── AWS ──────────────────────────────────────────────────────────
  AWS_REGION: z.string().default("us-west-2"),
  BEDROCK_REGION: z.string().optional(),

  // ── DynamoDB tables ──────────────────────────────────────────────
  CLIENTS_TABLE: z.string().min(1),
  DEDUP_TABLE: z.string().min(1),
  MEMOS_TABLE: z.string().min(1),
  AUDIT_TABLE: z.string().min(1),

  // ── S3 ──────────────────────────────────────────────────────────
  AUDIT_BUCKET: z.string().min(1),

  // ── SQS queues ───────────────────────────────────────────────────
  CRAWL_QUEUE_URL: z.string().url(),
  CLASSIFY_QUEUE_URL: z.string().url(),
  PUBLISH_QUEUE_URL: z.string().url(),
  AUDIT_QUEUE_URL: z.string().url(),

  // ── SQS consumer tuning ──────────────────────────────────────────
  CRAWL_CONCURRENCY: numeric("2").pipe(z.number().int().min(1).max(50)),
  CLASSIFY_CONCURRENCY: numeric("5").pipe(z.number().int().min(1).max(50)),
  PUBLISH_CONCURRENCY: numeric("2").pipe(z.number().int().min(1).max(50)),
  AUDIT_CONCURRENCY: numeric("5").pipe(z.number().int().min(1).max(50)),
  CONSUMER_POLL_INTERVAL_MS: numeric("1000").pipe(z.number().int().min(100)),

  // ── pgvector corpus ──────────────────────────────────────────────
  CORPUS_HOST: z.string().min(1),
  CORPUS_PORT: numeric("5432").pipe(z.number().int().min(1).max(65535)),
  CORPUS_DATABASE: z.string().min(1),
  CORPUS_USER: z.string().min(1),
  CORPUS_PASSWORD: z.string().min(1),

  // ── KMS ──────────────────────────────────────────────────────────
  ENVELOPE_KMS_KEY_ID: z.string().min(1),

  // ── Bedrock model IDs ────────────────────────────────────────────
  CLASSIFIER_MODEL_ID: z.string().default("us.anthropic.claude-sonnet-4-6-20250514-v1:0"),
  MEMO_MODEL_ID: z.string().default("us.anthropic.claude-sonnet-4-6-20250514-v1:0"),
  EMBEDDING_MODEL_ID: z.string().default("amazon.titan-embed-text-v2:0"),
  BEDROCK_TIMEOUT_MS: numeric("30000").pipe(z.number().int().min(1000)),

  // ── Classifier thresholds ────────────────────────────────────────
  // Scores ≥ APPLICABILITY_AUTO_ALERT_THRESHOLD publish a memo.
  // Scores ≥ APPLICABILITY_REVIEW_THRESHOLD land in the human-review
  // queue. Below that, the change is recorded but doesn't alert.
  APPLICABILITY_AUTO_ALERT_THRESHOLD: numeric("80").pipe(z.number().int().min(0).max(100)),
  APPLICABILITY_REVIEW_THRESHOLD: numeric("50").pipe(z.number().int().min(0).max(100)),

  // ── OAuth (Notion / Confluence) ─────────────────────────────────
  NOTION_OAUTH_CLIENT_ID: z.string().optional(),
  NOTION_OAUTH_CLIENT_SECRET: z.string().optional(),
  CONFLUENCE_OAUTH_CLIENT_ID: z.string().optional(),
  CONFLUENCE_OAUTH_CLIENT_SECRET: z.string().optional(),

  // ── Notifications ────────────────────────────────────────────────
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  RESEND_API_KEY: z.string().optional(),
  NOTIFICATION_FROM_EMAIL: z.string().email().default("watchtower@example.com"),

  // ── Security ─────────────────────────────────────────────────────
  STATE_SIGNING_SECRET: z.string().min(32),
});

export type Env = z.infer<typeof configSchema>;

export interface Config {
  readonly env: Env;
  readonly bedrockRegion: string;
  readonly nodeEnv: Env["NODE_ENV"];
  readonly isProd: boolean;
}

/** Load + validate config from `process.env`. Exits on failure. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(source);
  if (!result.success) {
    process.stderr.write("[config] invalid configuration:\n");
    for (const issue of result.error.issues) {
      process.stderr.write(`  - ${issue.path.join(".")}: ${issue.message}\n`);
    }
    process.exit(1);
  }
  const env = result.data;
  return {
    env,
    bedrockRegion: env.BEDROCK_REGION ?? env.AWS_REGION,
    nodeEnv: env.NODE_ENV,
    isProd: env.NODE_ENV === "production",
  };
}
