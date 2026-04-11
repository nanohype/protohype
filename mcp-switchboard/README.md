# mcp-switchboard

> Self-hosted MCP gateway. Six services — HubSpot, Google Drive, Google Calendar, Google Analytics, Google Custom Search, Stripe — exposed as remote MCP servers behind a single AWS API Gateway + Lambda endpoint.

## How It Works

```
Agent ──POST /hubspot──► API GW ──► Lambda ──► HubSpot MCP server ──► HubSpot API
Agent ──POST /gdrive───► API GW ──► Lambda ──► Google Drive MCP   ──► Drive API
Agent ──POST /gcal─────► API GW ──► Lambda ──► Calendar MCP       ──► Calendar API
Agent ──POST /analytics► API GW ──► Lambda ──► Analytics MCP      ──► GA4 API
Agent ──POST /gcse─────► API GW ──► Lambda ──► GCSE MCP           ──► CSE API
Agent ──POST /stripe───► API GW ──► Lambda ──► Stripe MCP         ──► Stripe API
```

Each route is a fully-compliant MCP Streamable HTTP endpoint. Credentials live in AWS Secrets Manager. One `cdk deploy` stands everything up.

## Quick Start

### 1. Install dependencies

```bash
npm install
cd infra && npm install && cd ..
```

### 2. Bootstrap CDK (first time only)

```bash
npx aws-cdk bootstrap
```

### 3. Deploy

```bash
cd infra && npx cdk deploy
```

CDK outputs the API endpoint URL after deploy.

### 4. Populate secrets

```bash
aws secretsmanager put-secret-value --secret-id mcp-switchboard/hubspot --secret-string '{"apiKey":"pat-na1-..."}'
# See CLAUDE.md for all services
```

### 5. Retrieve the bearer token

CDK auto-generates a token on first deploy. Retrieve it and add it to your Anthropic vault:

```bash
aws secretsmanager get-secret-value --secret-id mcp-switchboard/bearer-token --query SecretString --output text
```

### 6. Connect from your agent

All requests require an `Authorization: Bearer <token>` header. The Anthropic vault sends this automatically when the token is stored as an MCP credential. No headers needed in the agent config — just the URL:

```json
{
  "mcpServers": {
    "hubspot": {
      "type": "url",
      "url": "https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/hubspot"
    }
  }
}
```

## Tools (36 total)

| Service | Tools |
|---------|-------|
| HubSpot | 10 (contacts CRUD, deals CRUD, companies list, notes) |
| Google Drive | 5 (list, search, get, read, create) |
| Google Calendar | 6 (list calendars, events CRUD) |
| Google Analytics | 3 (report, realtime, list properties) |
| Google CSE | 2 (web search, image search) |
| Stripe | 10 (balance, customers CRUD, payments, subscriptions, invoices) |

## Local Development

```bash
cp .env.example .env   # fill in your credentials
npm run dev            # starts on http://localhost:3000
```

## Testing

```bash
npm test               # 42 unit tests, fully mocked
```

## Infrastructure

- **API Gateway** HTTP API — one route per service, all authenticated
- **Lambda Authorizer** — validates `Authorization: Bearer` header against Secrets Manager
- **Lambda** — Node.js 22, ARM64, 512 MB, 30s timeout, esbuild-bundled
- **Secrets Manager** — one secret per service + auto-generated API key, RETAIN on destroy
- **IAM** — Lambda reads `mcp-switchboard/*` secrets only
- **CloudWatch Logs** — 30-day retention

## Cost (estimated, minimal traffic)

| Resource | Monthly cost |
|----------|-------------|
| Lambda invocations (1M/mo) | ~$0.02 |
| API Gateway (1M requests) | ~$1.00 |
| Secrets Manager (6 secrets) | ~$2.40 |
| CloudWatch Logs | ~$0.50 |
| **Total** | **~$4/month** |
