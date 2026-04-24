import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.string().default("8080").transform(Number).pipe(z.number().int().min(1).max(65535)),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  AWS_REGION: z.string().default("us-west-2"),
  CDK_DEFAULT_REGION: z.string().optional(),

  DDB_TABLE_AUDIT: z.string().default("palisade-audit"),
  DDB_TABLE_LABEL_QUEUE: z.string().default("palisade-label-queue"),

  SQS_ATTACK_LOG_URL: z.string().url().optional(),
  SQS_ATTACK_LOG_DLQ_URL: z.string().url().optional(),

  S3_ARCHIVE_BUCKET: z.string().optional(),

  REDIS_URL: z.string().default("redis://localhost:6379"),

  PG_URL: z.string().default("postgres://palisade:palisade@localhost:5432/palisade"),

  BEDROCK_REGION: z.string().default("us-west-2"),
  BEDROCK_CLASSIFIER_MODEL_ID: z.string().default("anthropic.claude-haiku-4-5-20251001"),
  BEDROCK_EMBEDDING_MODEL_ID: z.string().default("amazon.titan-embed-text-v2:0"),

  // Detection thresholds
  HEURISTICS_BASE64_MIN_BYTES: z.coerce.number().int().positive().default(256),
  CLASSIFIER_BLOCK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  CLASSIFIER_ALLOW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.25),
  CORPUS_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.88),
  CORPUS_MATCH_TOP_K: z.coerce.number().int().positive().default(5),

  // Layer timeouts — fail-secure (treat as BLOCK) on breach
  HEURISTICS_TIMEOUT_MS: z.coerce.number().int().positive().default(50),
  CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(2500),
  CORPUS_MATCH_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),

  // Rate limit + escalation
  RATE_LIMIT_USER_PER_MIN: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_ESCALATION_SECONDS: z.coerce.number().int().positive().default(900),

  // OTel
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default("palisade"),

  // Upstream URLs — at least one must be set at deploy time
  UPSTREAM_OPENAI_URL: z.string().url().default("https://api.openai.com"),
  UPSTREAM_ANTHROPIC_URL: z.string().url().default("https://api.anthropic.com"),
  UPSTREAM_BEDROCK_URL: z.string().url().default("https://bedrock-runtime.us-west-2.amazonaws.com"),

  // Dev affordance: allow starting without AWS connectivity by toggling fakes.
  PALISADE_USE_FAKES: z.coerce.boolean().default(false),

  // Admin auth — required for /admin/* routes. Missing / empty in dev → admin
  // routes reject every request with 401. Production seeds a real key via
  // Secrets Manager; operators call admin routes with `Authorization: Bearer …`
  // or `X-Palisade-Admin-Key: …`.
  ADMIN_API_KEY: z.string().optional(),

  // Request body cap (bytes). Larger bodies reject with 413 before normalization.
  // Default is 1 MiB — plenty for normal chat payloads, small enough to keep
  // an attacker from trivially exhausting task memory.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),
});

export type Config = z.infer<typeof envSchema> & { region: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid palisade configuration:\n${issues}`);
  }
  const data = parsed.data;
  return {
    ...data,
    region: data.CDK_DEFAULT_REGION ?? data.AWS_REGION,
  };
}
