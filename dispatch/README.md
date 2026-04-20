# dispatch

Automated weekly newsletter pipeline for a Chief of Staff. Aggregates cross-team activity from GitHub, Linear, Notion, and Slack; resolves identities through WorkOS Directory Sync; redacts PII; drafts with Claude via Bedrock; gates on human approval before SES send.

Runs every Friday morning on a DST-correct schedule (two EventBridge rules — PST Nov-Mar, PDT Apr-Oct). One failed source does not fail the run — status becomes `PARTIAL` and the remaining sources still produce a draft. Every mutation to a draft is an immutable audit event; the edit-rate metric is derived from the ledger, never recomputed from current draft text.

## What This Is

A protohype project composing nanohype templates (`data-pipeline`, `worker-service`, `rag-pipeline`, `infra-aws`, `module-auth`, `slack-bot`) into a standalone weekly newsletter system. Infrastructure as code in `infra/`, app code in `src/` + `web/`, test suites in `src/**/*.test.ts`, migrations in `migrations/`.

**Not a template** — a real application. Fork it for a different client by swapping secrets, WorkOS directory, Slack workspace, Linear project, Notion database, and Grafana tenant — [`docs/forking-for-a-new-client.md`](docs/forking-for-a-new-client.md).

## How It Works

```
        EventBridge (DST-correct: PST + PDT rules)
                      │
                      ▼
 ┌──────────── ECS Fargate: pipeline ────────────┐
 │  Aggregators (provider registry)              │
 │   ├─ GitHub                                   │
 │   ├─ Linear                                   │
 │   ├─ Notion                                   │
 │   └─ Slack                                    │
 │                                               │
 │  → WorkOS Directory identity resolver          │
 │  → PII filter (pre AND post generation)       │
 │  → Ranker + deduper                           │
 │  → NewsletterGenerator (Bedrock + voice)      │
 │  → Draft written to Aurora + audit event      │
 └──────────┬────────────────────────────────────┘
            │
            ▼
 ┌──────── Slack #newsletter-review ─────────────┐
 │  "Draft ready — review by 11am"               │
 └──────────┬────────────────────────────────────┘
            │
            ▼
 ┌──────── ECS Fargate: web (Next.js) ───────────┐
 │  /review/[draftId] — inline edit, approve     │
 │   ↕ Fastify API (WorkOS JWT + Zod)             │
 │     GET  /drafts/:id                          │
 │     POST /drafts/:id/edits                    │
 │     POST /drafts/:id/approve  → SES send      │
 └───────────────────────────────────────────────┘
```

**Core invariant:** every mutation to a draft is an immutable audit event. Human edit deltas, approval timestamps, send receipts, expiry events — all flow through one `audit_events` table keyed on `run_id`. The edit-rate metric (character-level Levenshtein vs. auto-generated baseline) is derived from those events, never recomputed from the current draft text. That makes "who approved what and when" answerable in SQL forever.

**PII invariant:** items from aggregators cannot reach the LLM until they've passed through `sanitizeSourceItem`. The type system enforces this via a `SanitizedSourceItem` brand in `src/pipeline/types.ts` — the prompt builder literally cannot accept unsanitized items. `assertNoPii` then runs a second time on the LLM output.

## Architecture

- **`src/pipeline/index.ts`** — orchestrator. Five phases as OTel spans: `aggregate`, `dedupe`, `rank`, `generate`, `audit_and_notify`. Aggregators run in parallel via `Promise.allSettled`; a failed source is logged + counted in a metric, not fatal.
- **`src/pipeline/aggregators/`** — one module per source (`github`, `linear`, `notion`, `slack`). Each registers with the aggregator registry (`registry.ts`) via `createRegistry<T>` so adding a source never edits the orchestrator. Every external call is wrapped in `withTimeout` (8s default, 15s for Slack history) + `withRetry(3, jitter)`. Items pass through `sanitizeSourceItem` before leaving the aggregator.
- **`src/pipeline/filters/pii.ts`** — regex-based redaction: compensation, performance/HR, contact info, health, HR case IDs, SSN, credit card, DOB. `assertNoPii` runs at two checkpoints (post-aggregation and post-LLM output).
- **`src/pipeline/identity/workos.ts`** — WorkOS Directory Sync-backed identity resolver with 4-hour in-memory cache. Maps GitHub / Linear / Slack external IDs to `{ displayName, role, team }` via custom attributes on directory users. Batch-of-10 lookups; stale-cache fallback if the directory is unreachable.
- **`src/pipeline/ai/ranker.ts`** — scores items on age decay + engagement + metadata completeness, dedupes, maps to five canonical sections (`what_shipped`, `whats_coming`, `new_joiners`, `wins_recognition`, `the_ask`), caps each section at five items.
- **`src/pipeline/ai/generator.ts`** — `NewsletterGenerator` wraps Bedrock Claude with voice-baseline few-shots loaded from S3. Three sub-spans: `bedrock.load_voice_baseline`, `bedrock.invoke_model`, `bedrock.validate_output`. PII assertion at both ends; `withRetry` around the Bedrock call. On failure, falls back to a raw skeleton draft and audits `PIPELINE_FAILURE`.
- **`src/pipeline/audit.ts`** — awaited-only audit writes against the `DatabaseClient` interface. Zero fire-and-forget.
- **`src/pipeline/utils/resilience.ts`** — `withTimeout` + `withRetry` used at every external call site. `TimeoutError` is a distinct type so callers can branch on it.
- **`src/api/`** — Fastify server. Every route except `/health` is gated by a WorkOS JWT middleware (verified via `jose` against the WorkOS JWKS). `/approve` additionally checks the caller against an approver allow-list loaded from Secrets Manager (cached 5 min, rotatable without redeploy). Zod schemas at every boundary. SIGTERM drains in-flight requests before exit.
- **`web/`** — Next.js App Router review UI. `/review/[draftId]` page with inline edit, 2-second debounced save, live edit-rate chip (character-level Levenshtein), approve-and-send with a confirmation dialog. WorkOS AuthKit for sign-in.
- **`src/data/`** — Postgres-backed `DraftRepository` + `AuditWriter` implementations. Status transitions (`PENDING → APPROVED → SENT`) guarded by SQL `WHERE` clauses, so a draft cannot be approved twice or sent from a non-approved state.
- **`src/common/`** — shared Pino logger (stdout only — log shipping is an infrastructure concern), OTel bootstrap (`--import` loaded before app code), tracer + metrics accessors, Secrets Manager client with Zod-validated 5-minute cache, `createRegistry<T>`.
- **`infra/`** — CDK stack: VPC, Aurora Serverless v2, S3 (voice-baseline + raw-aggregations), ECS cluster with three Fargate services (pipeline, api, web), EventBridge (two DST-corrected rules), Secrets Manager (operator-seeded except `db-credentials`), ALB with `/health` health checks, CloudWatch alarms.

## Run locally

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
```

Full local-dev loop (Postgres, running a pipeline end-to-end with staging credentials, debugging a failing staging run): [`docs/local-development.md`](docs/local-development.md).

Quick Postgres:

```bash
docker run -d --name dispatch-pg -p 5432:5432 \
  -e POSTGRES_USER=dispatch_app -e POSTGRES_PASSWORD=dispatch_app \
  -e POSTGRES_DB=dispatchdb postgres:16
npm run migrate:up
npm run dev:pipeline
```

Long-running processes while iterating:

```bash
npm run dev:pipeline     # tsx watch src/pipeline/entrypoint.ts (one-shot orchestrator run)
npm run dev:api          # tsx watch src/api/entrypoint.ts, :3001
cd web && npm run dev    # Next.js dev server, :3000
```

## Test

```bash
npm test                 # vitest run — all suites
npm run test:watch       # interactive watch
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint on src/ + infra/
```

Trophy-shaped test distribution — strict static analysis (`tsconfig` strict + NodeNext, ESLint, Prettier), integration-heavy behavioral tests at the decision points (aggregator factories, orchestrator composition, identity cache, PII regex catalogue, resilience state machines, ranker scoring, Levenshtein diff), fewer pure unit tests, no e2e beyond the manual end-to-end in [`docs/deployment-guide.md`](docs/deployment-guide.md). Details + per-file coverage: [`docs/local-development.md`](docs/local-development.md) § "Tests".

## Build

```bash
npm run build            # tsc → dist/ (production build)
cd web && npm run build  # Next.js standalone bundle for Dockerfile.web
```

## Deploy

Two CDK stacks — `DispatchStaging` and `DispatchProduction` — coexist in one AWS account/region. Each provisions a VPC, Aurora Serverless v2, S3 buckets (voice-baseline + raw-aggregations), an ECS cluster with three Fargate services (pipeline scheduled, api + web always-on behind ALBs), an ADOT collector sidecar per task, EventBridge rules (two per env, DST-corrected; staging disabled by default), and CloudWatch alarms on the API's 5xx rate.

Resource names, secret paths, log groups, and IAM policies are all env-scoped (`DispatchStaging*` vs `DispatchProduction*`, `dispatch/staging/*` vs `dispatch/production/*`). The staging task roles **cannot** read production secrets (and vice versa).

```bash
cp secrets.template.json dispatch-secrets.staging.json
# Fill in real values — replace every REPLACE_ME. cookiePassword + authHeader
# auto-derive if left empty. `dispatch-secrets.*.json` is gitignored.
npm run seed:staging:dry     # validates shape, no AWS calls
npm run seed:staging         # creates/updates nine secrets in dispatch/staging/*

cd infra
npx cdk deploy DispatchStaging \
  -c workosClientId=client_01... \
  -c stagingDomain=dispatch-staging.internal.company.com \
  -c hostedZoneName=internal.company.com   # optional — provisions ACM + Route53 + HTTPS listeners
```

Requires Docker running locally, an `aws` CLI with creds, and Bedrock model access enabled in the deployment region. First-time deployers should stand staging up and run a manual end-to-end pipeline run **before** deploying production.

Full first-time walkthrough covering AWS prerequisites (Bedrock model access + on-demand-throughput caveat, SES identity verification, CDK bootstrap), third-party account setup, Secrets Manager seeding (nine operator-seeded secrets + one CDK-managed), WorkOS AuthKit wiring, voice-baseline corpus bootstrap, and the promotion path to production — [`docs/deployment-guide.md`](docs/deployment-guide.md).

**Forking Dispatch for a different client** — swap secrets, WorkOS directory, Slack workspace, Linear workspace, Notion database, and Grafana tenant without touching application code — [`docs/forking-for-a-new-client.md`](docs/forking-for-a-new-client.md).

**Secret seeding + rotation** — env-scoped inventory (`dispatch/staging/*`, `dispatch/production/*`), JSON payload shapes, `put-secret-value` commands, rotation cadence — [`docs/secrets.md`](docs/secrets.md).

**Slack app setup** — one-time Slack app provisioning per environment (bot scopes, channel memberships, HR-bot filtering) — [`docs/slack-app-setup.md`](docs/slack-app-setup.md).

## Configuration

All configuration via env vars (validated by Zod at startup — `src/api/config.ts` for the API, the `PipelineEnvSchema` in `src/pipeline/entrypoint.ts` for the pipeline). In production, secret values come from AWS Secrets Manager via the ECS task definition; `.env.example` is for local dev only. Full inventory + JSON payload shapes in [`docs/secrets.md`](docs/secrets.md).

| Variable | Source | Purpose |
|---|---|---|
| `AWS_REGION` | task def env | Region for Bedrock, S3, SES, Secrets Manager |
| `BEDROCK_MODEL_ID` | task def env | Claude model to invoke (default `us.anthropic.claude-sonnet-4-6` — cross-region inference profile required for on-demand throughput on Claude 4.x; switch to `eu.`/`ap.` outside the US) |
| `WORKOS_ISSUER` / `WORKOS_CLIENT_ID` | task def env | JWT validation against WorkOS JWKS — `aud` claim matches Client ID |
| `APPROVERS_SECRET_ID` | task def env → secret `dispatch/{env}/approvers` | `{ cosUserId, backupApproverIds[] }` — API reads on every `/approve` call (5-min cache) |
| `WORKOS_DIRECTORY_SECRET_ID` | task def env → secret `dispatch/{env}/workos-directory` | `{ apiKey, directoryId }` for Directory Sync |
| `GITHUB_SECRET_ID` / `LINEAR_SECRET_ID` / `SLACK_SECRET_ID` / `NOTION_SECRET_ID` | task def env → `dispatch/{env}/{github,linear,slack,notion}` | Per-provider credentials + integration config |
| `SLACK_REVIEW_CHANNEL_ID` / `SES_FROM_ADDRESS` / `NEWSLETTER_RECIPIENT_LIST` | projected fields of secret `dispatch/{env}/runtime-config` | Operational config co-located with secrets because ECS's `Secret.fromSecretsManager(..., 'field')` projects JSON fields into env vars |
| `DATABASE_URL` | local dev only — in AWS, built from `dispatch/{env}/db-credentials` | Postgres connection |
| `VOICE_BASELINE_BUCKET` / `RAW_AGGREGATIONS_BUCKET` | **set by CDK** | S3 bucket names injected at deploy |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` | **set by CDK** | Points at the ADOT collector sidecar on `localhost:4318`; tags traces with service + `deployment.environment` |
| `OTEL_SDK_DISABLED` | tests + any run without a collector | Short-circuits the SDK; Pino still writes to stdout |

## Observability

OpenTelemetry for traces + metrics. Logs are decoupled from OTel — apps emit Pino JSON to stdout, the ECS awslogs driver ships to CloudWatch, Grafana adds CloudWatch as a data source for unified UI. This keeps log routing out of the app: adding a Python or Go subsystem later is "emit JSON to stdout, done" with zero per-language transport plumbing.

- **Bootstrap** (`src/common/otel-bootstrap.ts`) loaded via `--import` in the pipeline + API Dockerfiles. Web uses `web/instrumentation.ts` (Next.js convention) + `web/lib/otel-browser.ts` (mounted via `OtelInit` client component).
- **Spans** — pipeline phases (`pipeline.run`, `phase.aggregate`, `phase.dedupe`, `phase.rank`, `phase.generate`, `phase.audit_and_notify`) and generator sub-phases (`bedrock.load_voice_baseline`, `bedrock.invoke_model`, `bedrock.validate_output`) are explicit. Fastify auto-instrumentation wraps every API request.
- **Metrics** (`src/common/metrics.ts`) — `dispatch.run.duration_ms{status}`, `dispatch.source.{items,failure}{source}`, `dispatch.bedrock.{tokens{kind,model},fallback}`, `dispatch.draft.edit_rate`, `dispatch.email.sent`.
- **Logs** — Pino → stdout → awslogs driver → CloudWatch log groups (`/dispatch/{env}/{pipeline,api,web}`). `trace_id` / `span_id` auto-injected by `@opentelemetry/instrumentation-pino`.
- **Unified Grafana view** — configure Grafana with CloudWatch as a logs data source (one-time UI step). Logs, traces (Tempo), and metrics (Mimir) all queryable together, joined on `trace_id`.
- **Sampling** — 100% (parent-based always-on at the SDK; the collector batches but does not down-sample).
- **Browser → API trace propagation** — W3C `traceparent` via `@opentelemetry/instrumentation-fetch`; the Next.js proxy routes and Fastify continue the trace, so a single trace spans browser → API → Postgres.

The secret `dispatch/{env}/grafana-cloud` carries `{ instanceId, apiToken, otlpEndpoint, authHeader }`. The operator pre-computes `authHeader = "Basic " + base64("instanceId:apiToken")` once. No `lokiEndpoint` — logs don't go through the collector.

`OTEL_SDK_DISABLED=true` short-circuits the SDK — used by tests and any run where the collector sidecar is not present. Pino still writes to stdout regardless.

## Conventions

- TypeScript, ESM (`"type": "module"`, `.js` extensions in relative imports)
- Node >= 24 (Active LTS)
- Zod for all input validation (API bodies, config, aggregator responses, Secrets Manager payloads)
- Structured JSON logging via Pino (`getLogger()` from `src/common/logger.ts`); the API uses Fastify's `logger: getLogger()`; the pipeline uses its own. `OTEL_SERVICE_NAME` drives the `service` field. `LOG_LEVEL=silent` in tests.
- Provider registry pattern (`createRegistry<T>`) for aggregators and identity resolvers
- Resilience contract: every external call uses `withTimeout` (8s default, 15s for Slack history) + `withRetry(3, jitter)`
- Audit writes are always awaited. Fire-and-forget on an audit event is a correctness bug, not a style issue.
- PII filter enforced via the `SanitizedSourceItem` brand: aggregators must call `sanitizeSourceItem` before items leave the boundary; the LLM prompt builder accepts only sanitized items.
- No framework lock-in for LLMs — direct Bedrock SDK via a thin interface.

## Dependencies

- `fastify` — API server
- `jose` — JWT validation against WorkOS JWKS
- `zod` — input validation
- `@aws-sdk/client-bedrock-runtime` — Claude via Bedrock
- `@aws-sdk/client-s3` — voice baseline corpus + raw aggregation snapshots
- `@aws-sdk/client-secrets-manager` — approvers, directory credentials, provider tokens
- `@aws-sdk/client-ses` — newsletter send
- `pg` — Postgres client
- `next`, `@workos-inc/authkit-nextjs`, `react` — web approval UI
- `@opentelemetry/*` — traces + metrics; `@opentelemetry/instrumentation-pino` for trace-context injection into log records
- `aws-cdk-lib` — infrastructure as code

## Reference docs

| Document | Path |
|---|---|
| Deployment guide (step-by-step, first-time) | [docs/deployment-guide.md](docs/deployment-guide.md) |
| Secrets inventory + seeding + rotation | [docs/secrets.md](docs/secrets.md) |
| Slack app setup (one-time per env) | [docs/slack-app-setup.md](docs/slack-app-setup.md) |
| Local development (dev loop + debugging failed runs) | [docs/local-development.md](docs/local-development.md) |
| Troubleshooting catalogue (every concrete error + fix) | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Forking Dispatch for a new client | [docs/forking-for-a-new-client.md](docs/forking-for-a-new-client.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Web review UI | [web/README.md](web/README.md) |
