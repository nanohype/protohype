/**
 * Environment configuration — validated at startup.
 * All external values come from env vars; no hardcoded defaults for secrets.
 */

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${raw}`);
  return n;
}

export const config = {
  aws: {
    region: optional("AWS_REGION", "us-west-2"),
  },
  dynamodb: {
    teamsTable: required("KILN_TEAMS_TABLE"),
    upgradesTable: required("KILN_UPGRADES_TABLE"),
    changelogsTable: required("KILN_CHANGELOGS_TABLE"),
    rateLimitTable: required("KILN_RATE_LIMIT_TABLE"),
  },
  github: {
    appSecretArn: required("GITHUB_APP_SECRET_ARN"),
    rateLimitPerHour: optionalInt("GITHUB_RATE_LIMIT_PER_HOUR", 4500),
    // Per-call timeouts (ms) — no default-infinity
    readTimeoutMs: 5_000,
    writeTimeoutMs: 15_000,
  },
  bedrock: {
    region: optional("BEDROCK_REGION", "us-west-2"),
    changelogModel: optional("BEDROCK_CHANGELOG_MODEL", "anthropic.claude-haiku-4-5"),
    migrationModel: optional("BEDROCK_MIGRATION_MODEL", "anthropic.claude-sonnet-4-6"),
    complexModel: optional("BEDROCK_COMPLEX_MODEL", "anthropic.claude-opus-4-6"),
    timeoutMs: 30_000,
    // Prompt caching mandatory — cache the system prompt prefix
    promptCachingEnabled: true,
  },
  npm: {
    registryUrl: "https://registry.npmjs.org",
    pollIntervalMs: optionalInt("NPM_POLL_INTERVAL_MS", 300_000),
    timeoutMs: 10_000,
  },
  okta: {
    domain: required("OKTA_DOMAIN"),
    audience: optional("OKTA_AUDIENCE", "api://kiln"),
  },
  server: {
    port: optionalInt("PORT", 3000),
    logLevel: optional("LOG_LEVEL", "info"),
  },
  changelog: {
    // Strict domain allowlist — arbitrary URLs rejected to prevent SSRF
    allowedDomains: [
      "github.com",
      "raw.githubusercontent.com",
      "registry.npmjs.org",
      "npmjs.com",
      "aws.amazon.com",
      "docs.aws.amazon.com",
      "react.dev",
      "nextjs.org",
      "www.prisma.io",
      "prisma.io",
      "unpkg.com",
    ],
    fetchTimeoutMs: 10_000,
  },
} as const;

export type Config = typeof config;
