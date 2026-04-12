# MCP Gateway

Unified API Gateway + Lambda CDK stack — the operational backbone for Claude managed agents.

**Three subsystems. One gateway. One deploy command.**

```
https://{API_GATEWAY_ID}.execute-api.us-west-2.amazonaws.com/
├── /mcp/{service}/*   →  MCP Switchboard (HubSpot, Drive, Calendar, Analytics, Search, Stripe)
├── /memory            →  MCP Memory Server (semantic storage for agent memory)
├── /dashboard/api/*   →  Cost Dashboard API (token usage + spend tracking)
└── /health            →  Health check (no auth)
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 22 | [nodejs.org](https://nodejs.org) · `.nvmrc` pins the version |
| AWS CLI | ≥ 2 | `brew install awscli` |
| AWS CDK | ≥ 2.130 | `npm install -g aws-cdk` |
| Docker | any | Required to build the embedding Lambda image |
| jq | any | `brew install jq` · used in verify commands |

AWS credentials must be configured:

```bash
aws configure
# Or: export AWS_PROFILE=your-profile
```

Verify:

```bash
aws sts get-caller-identity
```

---

## Deploy

### 1. Clone and install

```bash
git clone https://github.com/nanohype/protohype
cd protohype/mcp-gateway
npm install
```

### 2. Bootstrap CDK (first time only)

> Requires IAM permissions: CloudFormation full access, S3, ECR, IAM.

```bash
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-west-2
```

### 3. Deploy the stack

```bash
make deploy
# or: npm run deploy
```

Deployment takes **8–30 minutes on first run** (Docker build of the ~4 GB sentence-transformers image depends on connection speed), ~3 minutes on subsequent runs.

### 4. Get the API endpoint and bearer token

```bash
export API_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name McpGateway \
  --query "Stacks[0].Outputs[?ExportName=='McpGateway-ApiEndpoint'].OutputValue" \
  --output text)

export API_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id /mcp-gateway/gateway-bearer-token \
  --query SecretString --output text)

echo "API_ENDPOINT: $API_ENDPOINT"
echo "API_TOKEN: $API_TOKEN"
```

### 5. Verify the deploy

```bash
make verify
# Runs: health check, memory tools/list, 401 auth check
```

Or manually:

```bash
curl -f $API_ENDPOINT/health && echo "Gateway is up"

curl -s \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  $API_ENDPOINT/memory | jq .
```

---

## Configure Service Credentials

Secrets are created by CDK — populate values with your real credentials.

```bash
# Pattern
aws secretsmanager put-secret-value \
  --secret-id /mcp-gateway/mcp-switchboard/{service} \
  --secret-string '{"apiKey":"your-key-here"}'
```

**HubSpot**
```bash
aws secretsmanager put-secret-value \
  --secret-id /mcp-gateway/mcp-switchboard/hubspot \
  --secret-string '{"accessToken":"pat-na1-xxxxxxxx"}'
```

**Google Drive / Calendar / Analytics** (OAuth2)
```bash
aws secretsmanager put-secret-value \
  --secret-id /mcp-gateway/mcp-switchboard/google-drive \
  --secret-string '{"accessToken":"ya29.xxx","refreshToken":"1//xxx","clientId":"xxx.apps.googleusercontent.com","clientSecret":"GOCSPX-xxx"}'
```

> ⚠️ **Google OAuth access tokens expire after 1 hour.** For production use, prefer a [Google service account key](https://cloud.google.com/iam/docs/service-account-creds). The switchboard uses `accessToken` as-is — calls will return 401 after expiry.

**Google Custom Search**
```bash
aws secretsmanager put-secret-value \
  --secret-id /mcp-gateway/mcp-switchboard/google-custom-search \
  --secret-string '{"apiKey":"AIzaXXX","cx":"017xxxxxxxxxxxxxxx"}'
```

**Stripe**
```bash
aws secretsmanager put-secret-value \
  --secret-id /mcp-gateway/mcp-switchboard/stripe \
  --secret-string '{"apiKey":"sk_live_xxx"}'
```

---

## Configure spastic Agent MCP URLs

```json
{
  "mcpServers": {
    "hubspot": {
      "url": "https://{API_GATEWAY_ID}.execute-api.us-west-2.amazonaws.com/mcp/hubspot",
      "headers": { "Authorization": "Bearer {API_TOKEN}" }
    },
    "memory": {
      "url": "https://{API_GATEWAY_ID}.execute-api.us-west-2.amazonaws.com/memory",
      "headers": { "Authorization": "Bearer {API_TOKEN}" }
    }
  }
}
```

Replace `{API_GATEWAY_ID}` and `{API_TOKEN}` with values from step 4.

---

## MCP Servers

### Switchboard — `POST /mcp/{service}`

Third-party service proxy. The `{service}` path parameter is one of the allowlisted names; the body is a standard MCP JSON-RPC envelope. Credentials are fetched from Secrets Manager per service and cached for 5 minutes in Lambda memory.

Supported services: `hubspot`, `google-drive`, `google-calendar`, `google-analytics`, `google-custom-search`, `stripe`.

```bash
curl -X POST $API_ENDPOINT/mcp/stripe \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Memory — `POST /memory`

First-party MCP server for agent memory. Single endpoint, standard MCP JSON-RPC envelope. Tool list auto-discovered by any MCP client.

| Tool | Required args | Optional args |
|------|---------------|---------------|
| `memory_store`  | `agentId`, `text` | `summary`, `tags` (string[]), `ttl` (seconds), `metadata` |
| `memory_query`  | `agentId`, `query`   | `topK` (default 5), `threshold` (default 0.0) |
| `memory_list`   | `agentId`            | `limit` (max 100), `tags` (string[]) |
| `memory_delete` | `agentId`, `memoryId` | — |

```bash
curl -X POST $API_ENDPOINT/memory \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_store","arguments":{"agentId":"agt_xxx","text":"Customer prefers async standups.","ttl":2592000}}}'
```

Memories are scoped per `agentId`. `memory_query` runs cosine similarity on sentence-transformers embeddings (`all-MiniLM-L6-v2`, 384 dims). Current query cap: 500 memories per agent before the aggregation tier degrades — document this as a hard ceiling in consumer code.

---

## Cost Dashboard

> Make sure `$API_ENDPOINT` and `$API_TOKEN` are set before running this.

```bash
make dashboard-build   # builds Next.js static export
make dashboard-sync    # syncs to S3 + invalidates CloudFront

# Or in one shot after CDK deploy:
make full-deploy
```

Access the dashboard:

```bash
DASHBOARD_URL=$(aws cloudformation describe-stacks \
  --stack-name McpGateway \
  --query "Stacks[0].Outputs[?ExportName=='McpGateway-DashboardUrl'].OutputValue" \
  --output text)
open $DASHBOARD_URL
```

### Write cost events (perf-logger integration)

```bash
Consumers POST cost events to the gateway — the Lambda writes each event to S3 as its own object under `cost-events/{YYYY}/{MM}/{DD}/{agentId|unknown}/{sessionId}/{timestamp}-{rand}.json`. One file per event avoids read-modify-write races and keeps the write path idempotent.

```bash
curl -X POST $API_ENDPOINT/dashboard/api/cost \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "sess_xxx",
    "agentId": "agt_xxx",
    "agentRole": "eng-backend",
    "workflow": "feature-build",
    "model": "claude-sonnet-4-6",
    "speed": "standard",
    "inputTokens": 1234,
    "outputTokens": 567,
    "cacheReadTokens": 0,
    "cacheCreationTokens": 0,
    "costUsd": 0.012,
    "source": "managed_agents",
    "timestamp": "2026-04-11T14:00:00Z"
  }'
```

Required fields: `sessionId`, `model`, `inputTokens`, `outputTokens`, `costUsd`, `source` (`managed_agents` \| `advisor`), `timestamp` (ISO 8601).
Optional fields: `agentId` (defaults to `unknown` in the S3 key), `agentRole`, `workflow`, `speed` (`standard` \| `fast`), `cacheReadTokens`, `cacheCreationTokens`.

Response: `201 Created` with `{ "stored": true, "key": "cost-events/..." }`.

The `/summary` and `/agents` aggregations include a `bySource` breakdown so per-source spend is visible alongside totals.

Direct S3 writes also work if the consumer has IAM access — use the same schema with any unique key under the prefix.

### Set budget thresholds

```bash
aws lambda update-function-configuration \
  --function-name mcp-gateway-dashboard-api \
  --environment 'Variables={COST_DATA_BUCKET=...,DAILY_BUDGET_USD=50,MONTHLY_BUDGET_USD=1000}'
```

---

## Development

```bash
npm test          # unit tests (authorizer, switchboard, memory, CDK stack)
npm run synth     # synthesize without deploying
npm run diff      # diff against deployed stack
cd dashboard && npm run dev  # Next.js dev server (set .env.local first)
```

### Smoke tests

End-to-end tests against a deployed stack. Validates authorizer gate,
switchboard routing, memory CRUD, dashboard aggregations, cost ingest,
and the static site on CloudFront.

```bash
make smoke                     # auto-discovers endpoint + token from CloudFormation
STACK_NAME=McpStaging make smoke   # target a different stack
```

Tests run sequentially and use unique `smoketest-*` IDs so concurrent runs
don't collide. Memories created during the test are cleaned up in
`afterAll`; cost events stay (bucket lifecycle expires them at 365d). First
run will be slow — embedding Lambda cold start is ~30s. See
`smoke/README.md` for details.

---

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │        API Gateway HTTP API                  │
                    │   Bearer Token Lambda Authorizer             │
                    └──────────┬──────────┬────────────┬──────────┘
                               │          │            │
              ┌────────────────┘    ┌─────┘     ┌─────┘
              ▼                     ▼            ▼
   ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐
   │  MCP Switchboard │  │ MCP Memory   │  │ Dashboard    │
   │  /mcp/{service}  │  │  /memory     │  │ /dashboard   │
   └────────┬─────────┘  └──────┬───────┘  └──────┬───────┘
            │                   │                  │
   ┌────────┴──────┐   ┌────────┴──────┐   ┌───────┴──────┐
   │ Secrets Mgr   │   │ DynamoDB      │   │ S3 Bucket    │
   │ (per service) │   │ + Embedding   │   │ Cost Events  │
   └───────────────┘   │   Lambda      │   └──────────────┘
                       └───────────────┘

   CloudFront ──► S3 Static ──► Next.js Dashboard
```

---

## Stack Outputs

| Export Name | Description |
|-------------|-------------|
| `McpGateway-ApiEndpoint` | API Gateway base URL — use in spastic |
| `McpGateway-GatewaySecretArn` | Bearer token secret ARN |
| `McpGateway-MemoryTableName` | DynamoDB memory table |
| `McpGateway-MemoryEndpoint` | Memory server URL |
| `McpGateway-CostDataBucketName` | S3 bucket for perf-logger events |
| `McpGateway-DashboardUrl` | CloudFront dashboard URL |
| `McpGateway-StaticBucketName` | S3 bucket for dashboard static assets |

---

## Tear Down

```bash
cdk destroy  # Destroys all EXCEPT secrets + DynamoDB table (RemovalPolicy.RETAIN)
```

---

## Troubleshooting

**"No credentials found" on switchboard call** → Run `put-secret-value` for the service.

**401 on every request** → Check `Authorization: Bearer <token>` header. Token is in `/mcp-gateway/gateway-bearer-token`.

**Embedding Lambda timeout** → First invocation after cold start takes ~30s (model load). Consider provisioned concurrency.

**Dashboard shows no data** → Cost bucket is empty. Point perf-logger at `McpGateway-CostDataBucketName`.

**CDK diff shows DynamoDB replacement** → Never change `tableName` or key schema after first deploy.
