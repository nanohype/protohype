# dispatch

Automated weekly newsletter pipeline — aggregates cross-team activity, drafts with Claude via Bedrock, and gates on human approval before SES send.

## What This Is

A protohype project in the nanohype ecosystem. It composes patterns from nanohype templates (data-pipeline, worker-service, rag-pipeline, infra-aws, module-auth, slack-bot) into a working weekly newsletter system for a Chief of Staff.

Runs every Friday morning. Pulls from GitHub, Linear, Notion, and Slack; resolves identities through WorkOS Directory Sync; redacts PII; generates a voice-matched draft; posts to Slack for review; sends via SES only after explicit approval.

**Not a template** — a standalone application composed from template patterns.

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

Core insight: **every mutation to a draft is an immutable audit event**. Human edit deltas, approval timestamps, send receipts, expiry events — all flow through one `audit_events` table keyed on `run_id`. The edit-rate metric (character-level Levenshtein vs. auto-generated baseline) is derived from those events, never recomputed from the current draft text.

## Architecture

- **`src/pipeline/`** — ECS Fargate weekly task. Orchestrator in `index.ts` runs aggregators in parallel (`Promise.allSettled`), deduplicates, ranks, generates, audits, and notifies. One failed source does not fail the run (status becomes `PARTIAL`).
- **`src/pipeline/aggregators/`** — One module per source. Each exports a factory that registers with the aggregator registry (`registry.ts`) so adding a source never edits the orchestrator. All external calls wrapped in `withTimeout` (8s default, 15s for Slack history) + `withRetry(3, jitter)`. Items are passed through `sanitizeSourceItem` before leaving the aggregator so the LLM prompt builder only ever sees PII-filtered content (enforced by the `SanitizedSourceItem` brand).
- **`src/pipeline/filters/pii.ts`** — Regex-based redaction: compensation, performance/HR, contact info, health, HR case IDs, SSN, credit card, DOB. `assertNoPii` runs at two checkpoints: aggregation (post-piiFilter) and post-LLM output.
- **`src/pipeline/identity/workos.ts`** — WorkOS Directory Sync-backed identity resolver with 4-hour in-memory cache. Maps GitHub/Linear/Slack external IDs to canonical `{displayName, role, team}` via custom attributes on directory users.
- **`src/pipeline/ai/`** — `ranker.ts` scores items on age decay + engagement + metadata completeness. `generator.ts` wraps Bedrock Claude with voice-baseline few-shots loaded from S3, PII assertion at both ends, and `withRetry` around the Bedrock call.
- **`src/pipeline/audit.ts`** — Awaited-only audit writes against a `DatabaseClient` interface. Zero fire-and-forget.
- **`src/pipeline/utils/resilience.ts`** — `withTimeout` and `withRetry` used at every external call site.
- **`src/api/`** — Fastify server. Every route (except `/health`) gated by JWT middleware using `jose` against the WorkOS JWKS. Bodies validated with Zod. SIGTERM handler drains in-flight requests.
- **`src/web/`** — Next.js App Router. `/review/[draftId]` page with inline edit, live edit-rate indicator, approve-and-send action. Uses WorkOS AuthKit for authentication.
- **`src/data/`** — Postgres-backed `DraftRepository` and `AuditWriter` implementations. Migrations under `migrations/`.
- **`infra/`** — CDK stack: VPC, Aurora Serverless v2, S3 (voice-baseline + raw-aggregations), ECS cluster with three Fargate services (pipeline, api, web), EventBridge (two DST-corrected rules), Secrets Manager, ALB with `/health` health check, CloudWatch alarms.

## Commands

```bash
npm install

npm run dev:pipeline      # Run pipeline locally (needs DB + AWS creds)
npm run dev:api           # Fastify API on :3001

npm run build             # tsc --noEmit
npm run typecheck         # same as build
npm run lint              # ESLint on src/ and infra/
npm test                  # vitest run
npm run test:watch        # interactive watch

npm run migrate:up        # Apply pending migrations to DATABASE_URL
npm run migrate:down      # Roll back most recent migration

npm run infra:synth       # cdk synth (staging + prod)
npm run infra:deploy      # cdk deploy
```

## Configuration

All config via environment variables, validated with Zod. See `.env.example`.

Key ones:

- `AWS_REGION` — for Bedrock, S3, SES, Secrets Manager (default `us-east-1`)
- `BEDROCK_MODEL_ID` — defaults to Claude Sonnet 4
- `WORKOS_ISSUER` / `WORKOS_CLIENT_ID` — JWT validation against WorkOS JWKS
- `APPROVERS_SECRET_ID` — Secrets Manager secret with `{cosUserId, backupApproverIds[]}`
- `WORKOS_DIRECTORY_SECRET_ID` — Secrets Manager secret with `{apiKey, directoryId}` for WorkOS Directory Sync
- `DATABASE_URL` — Postgres connection. In production, loaded from `dispatch/{env}/db-credentials`
- `VOICE_BASELINE_BUCKET`, `RAW_AGGREGATIONS_BUCKET` — S3 buckets
- `SLACK_REVIEW_CHANNEL_ID` — channel for "draft ready" notifications

## Observability

OpenTelemetry for traces + metrics. Logs are decoupled from OTel —
apps emit Pino JSON to stdout, ECS awslogs driver ships to CloudWatch,
Grafana adds CloudWatch as a data source for unified UI when wanted.
This keeps log routing out of the app: adding a Python or Go subsystem
later is "emit JSON to stdout, done" with zero per-language transport
plumbing.

- **Bootstrap**: `src/common/otel-bootstrap.ts` loaded via `--import` in the pipeline + API Dockerfiles. Web uses `web/instrumentation.ts` (Next.js convention) for server-side and `web/lib/otel-browser.ts` (mounted via `OtelInit` client component in `app/layout.tsx`) for browser-side.
- **Tracer**: `getTracer()` from `src/common/tracer.ts`. Pipeline phases (`pipeline.run`, `phase.aggregate`, `phase.dedupe`, `phase.rank`, `phase.generate`, `phase.audit_and_notify`) and generator sub-phases (`bedrock.load_voice_baseline`, `bedrock.invoke_model`, `bedrock.validate_output`) are explicit spans.
- **Metrics**: defined in `src/common/metrics.ts`. `dispatch.run.duration_ms{status}`, `dispatch.source.{items,failure}{source}`, `dispatch.bedrock.{tokens{kind,model},fallback}`, `dispatch.draft.edit_rate{run_id}`, `dispatch.email.sent{run_id}`.
- **Logs**: Pino → stdout → ECS awslogs driver → CloudWatch log groups (`/dispatch/${env}/{pipeline,api,web}`). Trace context (`trace_id`, `span_id`) is auto-injected into log records by `@opentelemetry/instrumentation-pino`, so a CloudWatch line carries the trace_id you need to jump into Tempo. One shared Pino factory (`getLogger()`) is used by both the pipeline orchestrator and the Fastify API (`Fastify({ logger: getLogger() })`); the `OTEL_SERVICE_NAME` env var drives the `service` field, so the same factory tags pipeline logs `dispatch-pipeline` and API logs `dispatch-api`.
- **Unified Grafana view**: configure Grafana with CloudWatch as a logs data source (one-time UI step in Grafana, no infra change). Logs are then queryable in Grafana alongside Tempo traces and Mimir metrics, joined on `trace_id`.
- **Sampling**: 100% (parent-based always-on at the SDK; the collector batches but does not down-sample).
- **Browser → API trace propagation**: W3C `traceparent` header is added to fetch calls by `@opentelemetry/instrumentation-fetch`. The Next.js proxy routes and the Fastify auto-instrumentation continue the trace, so a single trace spans browser → API → Postgres.

The secret `dispatch/${env}/grafana-cloud` carries `{ instanceId, apiToken, otlpEndpoint, authHeader }`. Operator pre-computes `authHeader = "Basic " + base64("instanceId:apiToken")` once. (No `lokiEndpoint` field — logs don't go through the collector.)

`OTEL_SDK_DISABLED=true` short-circuits the SDK — used by tests and any deploy where the collector sidecar is not present. Pino still writes to stdout regardless.

## Conventions

- TypeScript, ESM (`"type": "module"`, `.js` extensions in relative imports)
- Node >= 24 (Active LTS)
- Zod for all input validation (API bodies, config, aggregator responses)
- Structured JSON logging via Pino (`getLogger()` from `src/common/logger.ts`); the API uses Fastify's bundled Pino instance, the pipeline uses its own. Both emit JSON. `LOG_LEVEL=silent` in tests.
- Provider registry pattern (`createRegistry<T>`) for aggregators and identity resolvers
- Resilience contract: every external call uses `withTimeout` (8s default, 15s for Slack history) + `withRetry(3, jitter)`
- Audit writes are always awaited
- No framework lock-in for LLMs — direct Bedrock SDK via a thin interface

## Testing

Unit tests per module with Vitest. Integration test hits a real Postgres container and mocks only Bedrock and external SDKs.

- `src/pipeline/filters/pii.test.ts` — every regex category + `assertNoPii`
- `src/pipeline/ai/ranker.test.ts` — scoring, dedup, section mapping, 5-item cap
- `src/pipeline/utils/resilience.test.ts` — timeout, retry-on-error, retry-exhaustion
- `src/web/lib/diff.test.ts` — Levenshtein on short + long inputs
- `src/pipeline/pipeline.integration.test.ts` — fake aggregators → resolver → filter → ranker → mock Bedrock → audit

Target: ≥ 42 passing assertions. Run with `npm test`.

## Not Yet Implemented

The following are planned but not in this revision. Each is tracked as a stub or planned feature:

- Real Notion MCP fetch (currently `fetchRecentPages` stub) — scoped to the all-hands database ID, validated per-page
- Real Slack MCP fetch (currently `fetchChannelHistory` stub)
- Real GitHub MCP fetch (currently `fetchMergedPRs` stub)
- Real Linear MCP fetch (currently `fetchClosedEpics` / `fetchUpcomingMilestones` / `fetchAskLabeledIssues` stubs)
- Voice baseline S3 listing (currently `listBaselineKeys` stub)
- (None currently — all MCP stubs are closed.)

These sit behind the resilience + registry layer, so swapping them in is a change to one module each, not the orchestrator.

## Dependencies

- `fastify` — API server
- `jose` — JWT validation against WorkOS JWKS
- `zod` — input validation
- `@aws-sdk/client-bedrock-runtime` — Claude via Bedrock
- `@aws-sdk/client-s3` — voice baseline corpus
- `@aws-sdk/client-secrets-manager` — approver list, SCIM token, DB credentials
- `@aws-sdk/client-ses` — newsletter send
- `pg` — Postgres client
- `next`, `@workos-inc/authkit-nextjs`, `react` — web approval UI
- `aws-cdk-lib` — infrastructure as code
