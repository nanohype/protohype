# mcp-switchboard

Self-hosted MCP gateway — HubSpot, Google Drive, Calendar, Analytics, CSE, and Stripe as remote MCP servers behind one AWS API Gateway + Lambda endpoint.

## What This Is

Composes the `mcp-server-ts` template pattern with `infra-aws` to deploy 6 MCP servers as remote HTTP endpoints. One Lambda, one API Gateway, six routes.

## Architecture

```
Agent (Claude) ──POST /hubspot──► API Gateway HTTP API
                                       │
                                    Lambda
                                   ┌───┴──────────────────────────────┐
                               parseServiceKey('/hubspot')             │
                               resolveServer('hubspot')                │
                               ← getSecret('mcp-switchboard/hubspot')  │
                               ← new Client({ accessToken: apiKey })   │
                               → McpServer (StreamableHTTPTransport)   │
                               → handleRequest → JSON-RPC response     │
                                   └──────────────────────────────────┘
```

**Transport:** MCP Streamable HTTP (stateless — `sessionIdGenerator: undefined`)  
**Auth:** AWS Secrets Manager — one secret per service under `mcp-switchboard/*` prefix  
**Infra:** CDK — `McpSwitchboardStack` in `infra/`

## Routes

| Path | Service | Secret Key |
|------|---------|-----------|
| POST /hubspot | HubSpot CRM | `mcp-switchboard/hubspot` → `{ apiKey }` |
| POST /gdrive | Google Drive | `mcp-switchboard/gdrive` → `{ serviceAccountKey }` |
| POST /gcal | Google Calendar | `mcp-switchboard/gcal` → `{ serviceAccountKey, impersonateEmail }` |
| POST /analytics | Google Analytics 4 | `mcp-switchboard/analytics` → `{ serviceAccountKey, propertyId }` |
| POST /gcse | Google Custom Search | `mcp-switchboard/gcse` → `{ apiKey, engineId }` |
| POST /stripe | Stripe | `mcp-switchboard/stripe` → `{ secretKey }` |

## Commands

```bash
# Install
npm install

# Local dev (uses .env for credentials)
cp .env.example .env && npm run dev

# Run tests
npm test

# Typecheck
npm run typecheck

# Bundle for Lambda (esbuild)
npm run bundle

# Deploy to AWS
cd infra && npm install && npx cdk deploy

# Destroy stack
cd infra && npx cdk destroy
```

## Project Structure

```
src/
  lambda.ts          # Lambda entry point — API GW event → MCP response
  local.ts           # Local dev server (Express, no Lambda needed)
  router.ts          # Path → service key → McpServer factory
  auth.ts            # Secrets Manager client + per-service credential loaders
  logger.ts          # JSON logger to stderr (stdout reserved for protocol)
  servers/
    hubspot.ts       # 10 HubSpot tools
    gdrive.ts        # 5 Google Drive tools
    gcal.ts          # 6 Google Calendar tools
    analytics.ts     # 3 Google Analytics 4 tools
    gcse.ts          # 2 Google Custom Search tools
    stripe.ts        # 10 Stripe tools
infra/
  bin/app.ts         # CDK app entry
  lib/mcp-switchboard-stack.ts  # CDK stack (API GW, Lambda, Secrets, IAM, CloudWatch)
tests/
  auth.test.ts       # Auth layer unit tests (AWS SDK mocked)
  router.test.ts     # Route parser tests
  servers/
    hubspot.test.ts  # HubSpot server tests (HubSpot SDK mocked)
    stripe.test.ts   # Stripe server tests (Stripe SDK mocked)
```

## Conventions

- TypeScript, ESM (`"type": "module"`, `.js` in imports)
- Node >= 22
- Zod for all tool input validation
- Structured JSON logging to stderr
- Every secret fetched from SM is cached in module scope for warm Lambda
- Tools are stateless — each invocation creates fresh API client instances
- No sessions — `sessionIdGenerator: undefined` in `StreamableHTTPServerTransport`

## Configuration: Tool Inventory

### HubSpot (10 tools)
`hubspot_list_contacts`, `hubspot_get_contact`, `hubspot_create_contact`, `hubspot_update_contact`, `hubspot_list_deals`, `hubspot_get_deal`, `hubspot_create_deal`, `hubspot_update_deal`, `hubspot_list_companies`, `hubspot_create_note`

### Google Drive (5 tools)
`gdrive_list_files`, `gdrive_search_files`, `gdrive_get_file`, `gdrive_read_file`, `gdrive_create_file`

### Google Calendar (6 tools)
`gcal_list_calendars`, `gcal_list_events`, `gcal_get_event`, `gcal_create_event`, `gcal_update_event`, `gcal_delete_event`

### Google Analytics 4 (3 tools)
`ga_run_report`, `ga_realtime_report`, `ga_list_properties`

### Google Custom Search (2 tools)
`gcse_search`, `gcse_search_images`

### Stripe (10 tools)
`stripe_get_balance`, `stripe_list_customers`, `stripe_get_customer`, `stripe_create_customer`, `stripe_list_payments`, `stripe_get_payment`, `stripe_list_subscriptions`, `stripe_get_subscription`, `stripe_list_invoices`, `stripe_get_invoice`

## Populating Secrets

After `cdk deploy`, populate each secret via CLI or Console:

```bash
# HubSpot
aws secretsmanager put-secret-value \
  --secret-id mcp-switchboard/hubspot \
  --secret-string '{"apiKey":"pat-na1-..."}'

# Stripe
aws secretsmanager put-secret-value \
  --secret-id mcp-switchboard/stripe \
  --secret-string '{"secretKey":"sk_live_..."}'

# Google Drive (service account key as escaped JSON string)
aws secretsmanager put-secret-value \
  --secret-id mcp-switchboard/gdrive \
  --secret-string "{\"serviceAccountKey\": $(cat service-account.json | jq -Rs .)}"

# Google Calendar (requires domain-wide delegation)
aws secretsmanager put-secret-value \
  --secret-id mcp-switchboard/gcal \
  --secret-string "{\"serviceAccountKey\": $(cat service-account.json | jq -Rs .), \"impersonateEmail\": \"you@yourdomain.com\"}"

# Google Analytics
aws secretsmanager put-secret-value \
  --secret-id mcp-switchboard/analytics \
  --secret-string "{\"serviceAccountKey\": $(cat service-account.json | jq -Rs .), \"propertyId\": \"123456789\"}"

# Google Custom Search
aws secretsmanager put-secret-value \
  --secret-id mcp-switchboard/gcse \
  --secret-string '{"apiKey":"AIzaSy...","engineId":"abc123..."}'
```

## Connecting from Claude (or any MCP client)

```json
{
  "mcpServers": {
    "hubspot": {
      "type": "http",
      "url": "https://{api-gateway-id}.execute-api.us-east-1.amazonaws.com/hubspot"
    },
    "gdrive": {
      "type": "http",
      "url": "https://{api-gateway-id}.execute-api.us-east-1.amazonaws.com/gdrive"
    }
  }
}
```

## Pre-Production Security Checklist

- [ ] Add API Gateway auth (see security-review.md)
- [ ] Enable KMS CMK for Secrets Manager
- [ ] Set Lambda reserved concurrency
- [ ] Run `npm audit` in CI
- [ ] Restrict CORS origins in CDK stack

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server + Streamable HTTP transport
- `@hubspot/api-client` — HubSpot CRM API
- `googleapis` — Google Drive, Calendar, Analytics, CSE
- `stripe` — Stripe API
- `@aws-sdk/client-secrets-manager` — AWS Secrets Manager
- `express` — Local dev server only
- `dotenv` — Environment variable loading for local dev
- `zod` — Tool input validation
- `aws-cdk-lib` — Infrastructure as code (infra/ only)

## Testing

```bash
npm test              # vitest run (unit tests, all mocked)
npm run test:watch    # interactive watch mode
```

4 test files:
- `tests/auth.test.ts` — 12 tests (Secrets Manager mock)
- `tests/router.test.ts` — 14 tests (path parsing)
- `tests/servers/hubspot.test.ts` — 8 tests (HubSpot SDK mock)
- `tests/servers/stripe.test.ts` — 8 tests (Stripe SDK mock)
