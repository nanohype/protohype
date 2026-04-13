import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  // Slack
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),

  // Okta
  OKTA_DOMAIN: z.string().url(),
  OKTA_CLIENT_ID: z.string().min(1),
  OKTA_CLIENT_SECRET: z.string().min(1),

  // Notion OAuth
  NOTION_CLIENT_ID: z.string().min(1),
  NOTION_CLIENT_SECRET: z.string().min(1),
  NOTION_REDIRECT_URI: z.string().url(),

  // Confluence OAuth
  CONFLUENCE_CLIENT_ID: z.string().min(1),
  CONFLUENCE_CLIENT_SECRET: z.string().min(1),
  CONFLUENCE_REDIRECT_URI: z.string().url(),
  CONFLUENCE_BASE_URL: z.string().url(),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),

  // LLM
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),

  // AWS
  AWS_REGION: z.string().default('us-east-1'),
  SECRETS_MANAGER_PREFIX: z.string().default('acmeask'),
  CLOUDWATCH_LOG_GROUP: z.string().default('/acmeask/audit'),

  // App
  PORT: z.string().default('3000').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  STALE_THRESHOLD_DAYS: z.string().default('90').transform(Number),
  RETRIEVAL_TIMEOUT_MS: z.string().default('1500').transform(Number),
  MAX_QUERIES_PER_HOUR: z.string().default('20').transform(Number),
  TOP_K_PER_CONNECTOR: z.string().default('5').transform(Number),
  TOP_K_FINAL: z.string().default('8').transform(Number),
  BASE_URL: z.string().url().default('https://acmeask.acmecorp.internal'),
});

function loadConfig() {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Missing or invalid environment variables: ${missing}`);
  }
  return result.data;
}

export const config = loadConfig();
export type Config = typeof config;
