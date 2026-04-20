# dispatch

Automated weekly newsletter pipeline. Aggregates cross-team activity from GitHub, Linear, Notion, and Slack; drafts with Claude via Bedrock; gates on human approval before SES send.

## Quick Start

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
```

For local pipeline run against a local Postgres:

```bash
docker run -d --name dispatch-pg -p 5432:5432 \
  -e POSTGRES_USER=dispatch_app -e POSTGRES_PASSWORD=dispatch_app \
  -e POSTGRES_DB=dispatch postgres:15
npm run migrate:up
npm run dev:pipeline
```

## Deployment

```bash
cd infra
cdk deploy DispatchStaging -c workosClientId=client_01...
```

Post-deploy, populate secrets (see `CLAUDE.md` for structure):

```bash
aws secretsmanager put-secret-value \
  --secret-id dispatch/staging/approvers \
  --secret-string '{"cosUserId":"user_01...", "backupApproverIds":["user_01..."]}'

aws secretsmanager put-secret-value \
  --secret-id dispatch/staging/workos-directory \
  --secret-string '{"apiKey":"sk_...", "directoryId":"directory_01..."}'

aws secretsmanager put-secret-value \
  --secret-id dispatch/staging/grafana-cloud \
  --secret-string '{"instanceId":"123456","apiToken":"glc_...","otlpEndpoint":"https://otlp-gateway-prod-us-west-0.grafana.net/otlp","authHeader":"Basic <base64(instanceId:apiToken)>"}'
```

## Architecture

```
EventBridge → ECS pipeline → Aurora (drafts, audit_events)
                           ↘ Slack #newsletter-review
                           ↘ ECS api (Fastify + Zod + WorkOS JWT)
                             ↕
                             ECS web (Next.js + AuthKit) — /review/[draftId]
                             ↘ SES send on approve
```

See `CLAUDE.md` for the module-by-module breakdown.

## Project Conventions

- TypeScript, ESM, Node >= 24
- Zod for input validation
- Provider registry pattern for aggregators
- `withTimeout` (8s default, 15s for Slack history) `+ withRetry(3, jitter)` on every external call
- Audit writes awaited; never fire-and-forget
- PII filter enforced via the `SanitizedSourceItem` brand: aggregators must call `sanitizeSourceItem` before items leave the boundary; the LLM prompt builder accepts only sanitized items
- Structured JSON logging via Pino (`getLogger()` from `src/common/logger.ts`); `LOG_LEVEL=silent` in tests

## Troubleshooting

- **WorkOS JWT verify fails** — confirm `WORKOS_CLIENT_ID` matches the AuthKit client that issued the access token. The `aud` claim must equal `WORKOS_CLIENT_ID`.
- **Identity resolution returns null for everyone** — the WorkOS Directory must have `githubLogin`, `slackUserId`, and `linearUserId` configured as custom attributes per directory user. Without them, every external-id lookup returns null and the pipeline runs as PARTIAL with anonymous authors.
- **Bedrock returns garbage / generation throws** — the orchestrator falls back to a raw skeleton draft built from the ranked sections. The Slack alert prefix is `Bedrock generation failed — raw skeleton draft posted`. The operator can edit and approve in the same UI; the skeleton's first line carries a visible warning banner.
- **Slack history call times out** — Slack ingestion has a 15s budget per channel call; the rest of the aggregators use 8s. If the budget is still tight, confirm the bot is in both `announcementsChannelId` and `teamChannelId`.
- **Local pipeline can't reach AWS** — `dev:pipeline` needs `AWS_REGION` plus active credentials (e.g. `aws sso login`). Without them, Secrets Manager calls fail before any aggregator runs.
- **`request timeout` on the API** — the Fastify server caps any single request at 30s. If a Postgres query stalls, the client gets a 408 instead of hanging.
- **Traces not showing in Grafana** — check the collector container logs at `/dispatch/${env}/otel-collector-{pipeline,api,web}` for export errors. Malformed `authHeader` is the usual cause; verify it's `Basic ` + base64-encoded `instanceId:apiToken`.
- **Logs not in Grafana** — logs go to CloudWatch, not Loki. Add CloudWatch as a Grafana data source (one-time UI step) to query them alongside traces and metrics. The `trace_id` field in each log line joins to Tempo.
- **Pipeline task hangs after the run** — the collector sidecar is `essential: false` and the app container declares a START dependency on it, so when the app exits the task should terminate. If a task stays in RUNNING, check `aws ecs describe-tasks` for container stop-codes.
