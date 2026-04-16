# chorus

Cross-channel feedback intelligence — library scaffold for a pipeline that ingests customer feedback (push-based via Slack Events + generic webhook), redacts PII, embeds via Bedrock Titan, matches against Linear backlog entries with pgvector cosine similarity, and proposes LINK-or-NEW entries for PM review.

## What This Is

This package ships the **building blocks**, not the running pipeline. In v0.1.0 it contains:

- shared infrastructure (DB pool, HTTP client with timeout + retry, WorkOS AuthKit JWT auth, secrets cache, SQS DLQ sender, JSON logger)
- matching primitives (PII redactor, Titan embedder, pgvector matcher, Haiku title generator)
- SQL schema with HNSW and GIN indexes
- a versioned migration runner

It does **not** ship: ingestion orchestrator, push-based ingestion routes, Linear sync, REST API, PM review UI, weekly digest job, AWS CDK stack, or the eval harness. Those land in follow-on releases — see the roadmap in `README.md`.

## How It Works

The matching core is a three-stage flow that callers compose:

```
feedback text
    │
    ▼
redactPii()            ← regex pass + AWS Comprehend pass; returns RedactedText
    │
    ▼
embedSingle()          ← Bedrock Titan Embed v2 → 1024-dim vector
    │
    ▼
findMatch()            ← pgvector cosine search (top-5, HNSW index)
    │                     → LINK if topScore ≥ MATCH_THRESHOLD (default 0.78)
    │                     → LINK if any ≥ DUPLICATE_THRESHOLD 0.85 (dup guard)
    │                     → NEW  with Claude Haiku draft title otherwise
    ▼
MatchProposal
```

Every stage writes an `audit_log` row keyed by correlation ID; the audit write is synchronous and awaited.

## Architecture

| Path | Purpose |
|---|---|
| `src/lib/audit.ts` | `auditLog(entry)` — INSERT into `audit_log`, awaited. |
| `src/lib/auth.ts` | `validateAccessToken` (WorkOS RS256), `canAccessEvidence` (ACL check), `requireAuth` Express middleware. Fail-closed on unset env vars. |
| `src/lib/db.ts` | `getDbPool()` singleton — `pg.Pool` with bounded size, idle/connection timeouts. |
| `src/lib/http.ts` | `createExternalClient(config)` — `fetch` wrapper with 10 s timeout hard-cap, jittered exponential backoff on 429/503/504, max 3 retries. |
| `src/lib/observability.ts` | Structured JSON logger (stdout), correlation-id middleware, `withCorrelation` tracing helper. |
| `src/lib/telemetry.ts` | OpenTelemetry SDK bootstrap. Exports OTLP HTTP to `localhost:4318` (ADOT sidecar in Fargate → Grafana Cloud). No-op when `OTEL_SDK_DISABLED=true`. |
| `src/lib/telemetry-register.ts` | Loaded via `node --import` in every container so auto-instrumentations install before user code. |
| `src/lib/telemetry-hooks.ts` | `withSpan(name, attrs, fn)` plus typed metric recorders: `recordPipelineStage`, `recordIngestItem`, `recordProposalDecision`, `setBreakerState`. |
| `src/audit/audit-consumer.ts` | SQS consumer that drains the audit queue (when `AUDIT_QUEUE_URL` is set) and performs the INSERTs off the request path. Runs as a dedicated Fargate service. |
| `infra/lib/adot-sidecar.ts` | CDK helper that attaches an ADOT collector sidecar to every Fargate task. Config in `infra/lib/adot-config.yaml`. |
| `src/lib/directory.ts` | `createDirectoryClient` — paginated WorkOS Directory Sync `/directory_users` iterator, filtered by group id. |
| `src/lib/queue.ts` | `getDlqClient()` — SQS sender; falls back to stderr if `DLQ_URL` unset. |
| `src/lib/secrets.ts` | `getSecretString(name)` — Secrets Manager with 5-min in-memory cache. |
| `src/lib/slack.ts` | `getSlackClient()` — `postMessage` + `sendDm` with `unfurl_links: false`. |
| `src/matching/embedder.ts` | `embedBatch` / `embedSingle` — Titan v2 at 1024 dims, normalized. Consumes the `RedactedText` branded type declared in `src/matching/redacted-text.ts`. |
| `src/matching/matcher.ts` | `findMatch(correlationId, feedbackItemId, embedding, feedbackText, deps)` — pgvector cosine search, LINK/NEW decision, duplicate guard. |
| `src/matching/pii-redactor.ts` | `redactPii(correlationId, text)` — regex for emails/phones/URL params, Comprehend pass for names/addresses/etc. |
| `src/matching/title-generator.ts` | `generateDraftTitle(RedactedText)` — Claude Haiku, constrained prompt (≤10 words, gerund form). |
| `migrations/001_init.sql` | Schema: `feedback_items`, `raw_evidence`, `backlog_entries`, `audit_log`, `ingestion_cursors` + HNSW + GIN indexes. |
| `scripts/migrate.ts` | Versioned migration runner backed by `schema_migrations` table. |
| `evals/labeled-set-schema.md` | JSONL schema for the labeled set the (future) eval harness will consume. |

## Commands

The `Makefile` is the canonical entry point — `make help` lists targets. Most common:

```
make install     # npm ci
make ci          # typecheck + lint + format-check + test + build
make test        # vitest run
make migrate     # apply pending SQL migrations (needs DATABASE_URL)
make clean       # rm -rf dist node_modules coverage
```

Underlying npm scripts are still callable directly (`npm run typecheck`, `npm run build`, `npm run lint`, `npm run format`, `npm run format:check`, `npm run test:watch`).

## Configuration

All env vars are required at first use — no placeholder defaults. See `.env.example` for the complete list. Key groups:

- Database: `DATABASE_URL`
- WorkOS: `WORKOS_CLIENT_ID` (required), optional `WORKOS_ISSUER`, `WORKOS_DIRECTORY_ID`, `WORKOS_PM_GROUP_ID`
- AWS: `AWS_REGION`, `DLQ_URL`
- Models: `EMBEDDING_MODEL_ID`, `TITLE_GEN_MODEL_ID`
- Matching: `MATCH_THRESHOLD`

Secrets (WorkOS API key, Slack bot token) are fetched from AWS Secrets Manager by name at use time.

## Conventions

- ESM (`"type": "module"`, `.js` import suffixes).
- Strict TypeScript — `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`.
- 2-space indent, Prettier-formatted, single quotes.
- Structured JSON logs to stdout; one line per event.
- Correlation ID threaded through every stage (`correlationId: string`) and included in audit rows.
- Every outbound HTTP call goes through `createExternalClient`. No ad-hoc `fetch` in pipeline code.
- Every env var read fails closed if the value is missing. No placeholder URL defaults.
- OpenTelemetry is the shared observability surface. Every container is launched with `node --import ./dist/src/lib/telemetry-register.js` so auto-instrumentations (http, pg, express) patch before user code. Hot paths (pipeline stages, external HTTP, SDK calls) carry manual spans with `chorus.correlation_id`, `chorus.stage`, and `chorus.breaker.state` attributes. Metrics + traces + logs flow to the ADOT collector sidecar on `localhost:4318` and from there to Grafana Cloud.
- The `RedactedText` branded type is a compile-time marker. The only legitimate producers are `createPiiRedactor` (brands values after running regex + Comprehend) and `rehydrateRedacted` (brands values read back out of the `feedback_items.redacted_text` column). Tests use `asRedactedForTests`.

## Testing

`src/lib/auth.test.ts` and `src/matching/matcher.test.ts` exercise the pure parts (ACL logic, LINK/NEW decision with stubbed `MatcherDeps`). Run: `npm run test`. The 500-item eval harness — the quantitative accuracy gate — is not part of this release; only the input schema at `evals/labeled-set-schema.md` is committed.

## Dependencies

| Package | Why |
|---|---|
| `@aws-sdk/client-bedrock-runtime` | Titan embeddings, Haiku generations |
| `@aws-sdk/client-comprehend` | PII detection |
| `@aws-sdk/client-secrets-manager` | credential storage |
| `@aws-sdk/client-sqs` | DLQ |
| `express` | middleware types + future REST API host |
| `jose` | WorkOS AuthKit RS256 JWT verification |
| `pg` | Postgres client, pgvector through the `vector` type |
| `@opentelemetry/sdk-node` + `auto-instrumentations-node` + OTLP HTTP exporters | OpenTelemetry emission; ADOT sidecar ships to Grafana Cloud |

Lint/test stack: `eslint`, `@typescript-eslint/*`, `prettier`, `vitest`, `@vitest/coverage-v8`.
