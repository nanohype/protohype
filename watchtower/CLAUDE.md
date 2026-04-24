# watchtower

Regulatory change radar — detects rule changes at public regulators, classifies them against per-client products × jurisdictions × frameworks configs, drafts impact memos, and publishes on human approval.

## What This Is

A protohype project in the nanohype ecosystem. Composes patterns from `worker-service`, `module-observability-ts`, `module-vector-store`, `module-notifications-ts`, `module-knowledge-base-ts`, `data-pipeline`, `eval-harness`, and `infra-aws` into a working application. The CDK stack is wired on `@nanohype/cdk-constructs` v0.1.0.

**Built as a reusable subsystem.** Every external-IO service is a `createXxx(deps)` factory accepting typed ports (DynamoDB document clients, SQS client, Bedrock runtime, `LlmProvider`, `VectorStorePort`, `PublisherPort`, ...). `src/index.ts` is the single place real SDK clients are constructed; every downstream factory runs against port interfaces. Swapping Bedrock → another LLM, pgvector → OpenSearch, Notion → Confluence, SEC EDGAR → a different regulator is a one-file change.

**Core insight:** the novelty is the _applicability classifier_, not the diff. Rule X matters to Client A and not Client B; watchtower captures that asymmetry as a declarative per-client config. A Bedrock Claude call scores each `(rule_change, client)` pair on a 0–100 scale; scores ≥ auto-alert fire, scores between review and auto-alert land in a human-review queue, lower scores are recorded but don't alert. Classifier errors (timeout, schema, LLM throw) **always** route to review via fail-secure — never silently drop.

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│  EventBridge Scheduler (per-source cadence)                         │
│     sec-edgar 1h · cfpb 1h · ofac 30m · edpb 6h                     │
└─────────────┬───────────────────────────────────────────────────────┘
              │ { source: "sec-edgar" }
              ▼
         ╔═══════════╗
         ║ crawl SQS ║
         ╚═════╤═════╝
               │
               ▼
       crawl handler  ────► dedup (DDB) — (sourceId, contentHash)
               │                 │
               │                 └─► skip if already emitted
               │
               ├──► RULE_CHANGE_DETECTED → audit SQS (FIFO)
               ├──► corpus indexer → pgvector (chunks + titan embeddings)
               ├──► for each active client: enqueue classify
               └──► mark dedup LAST (crash-safe — replays if we died)

         ╔═════════════╗
         ║ classify SQS ║
         ╚══════╤═══════╝
                │ { clientId, ruleChange }
                ▼
        classify handler
                │
                ├─► classifier (Bedrock Claude)
                │      score 0-100 + confidence + rationale
                │      fail-secure: error → review, never drop
                │
                ├─► APPLICABILITY_SCORED → audit
                │
                ├── disposition == "drop"    → return
                │
                ├── disposition in ("review", "alert"):
                │      ├─► drafter (Bedrock Claude) → MemoRecord
                │      ├─► memos DDB (status: pending_review)
                │      ├─► MEMO_DRAFTED → audit
                │      └─► notifier (Slack + email per client config)
                │              └─► ALERT_SENT → audit per channel
                │
                └── disposition == "alert":
                       └─► enqueue publish queue (memoId, clientId)

         ╔════════════╗
         ║ publish SQS ║
         ╚══════╤══════╝
                │ { memoId, clientId }
                ▼
        publish handler ─► approval gate (two-phase commit)
                              │
                              ├─ Phase 1: ConsistentRead memo
                              │     if status != "approved":
                              │         ApprovalRequiredError → soft-ack
                              │         (operator re-enqueues later)
                              │
                              └─ Phase 2: publisher.publish()
                                          │
                                          ├─ success → DDB transition
                                          │    approved → published
                                          │    with ConditionExpression
                                          │    MEMO_PUBLISHED → audit
                                          │
                                          ├─ publisher error → audit
                                          │    MEMO_PUBLISH_BLOCKED
                                          │    throw → SQS retry/DLQ
                                          │
                                          └─ state race → audit
                                               MEMO_PUBLISH_BLOCKED
                                               PublishConflictError

         ╔═══════════╗
         ║ audit SQS ║ (FIFO, MessageGroupId=clientId, dedup=eventId)
         ╚═════╤═════╝
               │
               ▼
         Lambda audit consumer (bundled with NodejsFunction)
               ├─► audit DDB (90d hot TTL)
               └─► audit S3 archive (intelligent-tiering @90d, 1y expiration)
```

**Cold-start:** first crawler invocation marks every item as "new"; the dedup table fills up progressively. If the classifier hasn't been evaluated against the client configs yet, `APPLICABILITY_AUTO_ALERT_THRESHOLD=100` disables auto-alerts (everything routes to review until the eval suite sets an informed threshold).

## Architecture

Every module that touches an external boundary exposes a `createXxx(deps)` factory. Bootstrap in `src/index.ts` builds the SDK clients once and hands them in.

- **src/config/** — Zod env schema covering every variable the CDK stack exposes plus every secret the ECS task injects. `loadConfig()` fails fast with per-field errors and exits on missing/invalid input. Derived `bedrockRegion` (falls back to `AWS_REGION`) and `isProd`.
- **src/otel/** — `initTelemetry({ serviceName, serviceVersion, environment, region })` merges resource attributes into `OTEL_RESOURCE_ATTRIBUTES` before the auto-instrumentation SDK boots via the Dockerfile's `--require` hook.
- **src/logger.ts** — zero-dep JSON logger. Reads `currentTraceId()` on every emit and mixes it into every log line; scopes propagate via `AsyncLocalStorage` (see `src/context.ts`).
- **src/context.ts** — `AsyncLocalStorage<{ traceId }>`. `withTraceContext(fn, id?)` scopes the trace through nested async. Consumer's `processJob` wraps each job in a scope automatically.
- **src/metrics.ts** — OTel counters + histograms (`worker_job_total`, `worker_job_duration_ms`). Consumed by the consumer handler.
- **src/consumer/** — generic queue consumer. `createQueueConsumer(provider, handlers, logger, opts)` polls, dispatches by job name, acknowledges on success, fails on error. Circuit breaker wraps `provider.dequeue()` so a flaky SQS doesn't get hammered. `createSqsQueueProvider` is the concrete adapter.
- **src/resilience/circuit-breaker.ts** — three-state machine (closed / open / half-open) with instance-local state. Used by the consumer dequeue and the HTTP fetcher.
- **src/health/** — Hono `/health` (liveness, always 200) + `/readyz` (named readiness checks map). `buildHealthApp` is exported for in-process testing.
- **src/clients/** — per-client config registry. Zod-validated `ClientConfig` (products × jurisdictions × frameworks + optional notifications + publish targets). DDB adapter scans with a 60s cache on `listActive()`; `get()` uses `GetItem` with ConsistentRead off (single-client lookups are small and hot-path safe). In-memory `FakeClients` for tests and local dev.
- **src/audit/** — discriminated-union audit events (`RULE_CHANGE_DETECTED`, `APPLICABILITY_SCORED`, `MEMO_DRAFTED`, `MEMO_APPROVED`, `MEMO_PUBLISHED`, `MEMO_PUBLISH_BLOCKED`, `ALERT_SENT`) validated with Zod at the boundary. `createSqsAuditLogger` writes to the audit FIFO queue with `MessageGroupId=clientId` + `MessageDeduplicationId=eventId` (exactly-once per event in the SQS dedup window). Failures propagate — never silent.
- **src/crawlers/** — regulator feed ingestion.
  - `types.ts`: `Crawler`, `RuleChange` (Zod), `DedupPort`.
  - `http.ts`: HTTP fetcher with per-source circuit breaker + `AbortSignal.timeout()`.
  - `hash.ts`: stable SHA-256 over (title, url, normalized body) for dedup.
  - `rss.ts`: generic RSS 2.0 / Atom crawler (`fast-xml-parser`). Permissive parsing; items missing title or link drop with a warn.
  - `dedup.ts`: DDB adapter using `ConditionalCheckFailedException` as the "already seen" signal (idempotent on racing workers).
  - `registry.ts` + `sources.ts`: seed set — SEC EDGAR, CFPB, OFAC, EDPB. Fork this file for different clients.
- **src/pipeline/** — corpus indexer.
  - `chunker.ts`: zero-dep recursive chunker (paragraph → line → sentence → word → hard-slice fallback).
  - `embed-bedrock.ts`: Bedrock Titan Embed v2 with client-side fan-out concurrency (Titan has no batch endpoint).
  - `pgvector.ts`: cosine-HNSW pgvector adapter. `ensureCorpusSchema()` creates the `vector` extension + `rule_chunks` table idempotently on app boot.
  - `indexer.ts`: delete-then-upsert per rule change — revised bodies replace old chunks atomically, no stale embeddings linger.
- **src/classifier/** — applicability classifier.
  - `bedrock.ts`: Bedrock Claude provider implementing `LlmProvider`. Cross-region inference profile format; messages API via `InvokeModelCommand` with `AbortSignal.timeout()`.
  - `classifier.ts`: THE fail-secure invariant. LLM error / timeout / non-JSON / schema-invalid → `disposition: review`, `failureMode` set. Never routes to `drop` on failure.
- **src/memo/** — memo drafter + storage.
  - `drafter.ts`: Bedrock Claude memo drafter. Not fail-secure — a failed draft throws and SQS retry/DLQ handles it.
  - `storage.ts`: DDB-backed state machine (`pending_review` → `approved`/`rejected`; `approved` → `published`). ConsistentRead on `getConsistent` is load-bearing — the approval gate depends on it.
- **src/publish/** — the security-critical layer.
  - `approval-gate.ts`: THE ONLY sanctioned path into `PublisherPort.publish()`. Two-phase commit: Phase 1 ConsistentRead verifies `status === "approved"`; Phase 2 atomic DDB transition with ConditionExpression after the external publish completes. Enforced by a CI grep-gate.
  - `notion.ts` / `confluence.ts`: native-fetch adapters. Markdown → Notion blocks / Confluence storage format.
  - `types.ts`: `PublisherPort`, `ApprovalRequiredError`, `PublishConflictError`.
- **src/notify/** — multichannel alert dispatch.
  - `slack.ts`: webhook POST with Block Kit payload.
  - `email.ts`: Resend REST adapter.
  - `notifier.ts`: per-channel isolation — email down doesn't block Slack. One `ALERT_SENT` audit per successful channel.
- **src/handlers/** — queue bridges. Each handler validates its message with Zod at the boundary, then delegates to the domain modules.
- **src/index.ts** — single wiring file (~215 LOC). Builds SDK clients, constructs ports, starts three consumers (crawl / classify / publish), runs `ensureCorpusSchema` on boot, wires SIGTERM/SIGINT graceful shutdown.

## Commands

```bash
npm run dev            # tsx watch — src/index.ts
npm run build          # tsc -p tsconfig.build.json → dist/
npm start              # node dist/index.js
npm test               # vitest run — 14 files, 106 tests
npm run test:watch     # interactive
npm run test:coverage  # v8 coverage
npm run test:packages  # fan-out across packages/*
npm run lint           # eslint src/
npm run lint:packages  # per-package lint
npm run lint:infra     # cd infra && npm run lint
npm run lint:all       # root + packages + infra
npm run format         # prettier --write .
npm run format:check   # prettier --check .
npm run typecheck      # tsc --noEmit
npm run check          # typecheck + lint + format:check + test
npm run audit:prod     # npm audit --audit-level=high --omit=dev
```

Infrastructure (`watchtower/infra/`):

```bash
npm ci
npm run synth          # cdk synth (both stacks)
npm run deploy         # cdk deploy <StackName>
npm run diff           # cdk diff
```

## Configuration

All config via env vars, validated in `src/config/index.ts`. The CDK stack populates the required ones automatically. For local dev, copy `.env.example` to `.env`.

Required (no defaults): `CLIENTS_TABLE`, `DEDUP_TABLE`, `MEMOS_TABLE`, `AUDIT_TABLE`, `AUDIT_BUCKET`, `CRAWL_QUEUE_URL`, `CLASSIFY_QUEUE_URL`, `PUBLISH_QUEUE_URL`, `AUDIT_QUEUE_URL`, `CORPUS_HOST`, `CORPUS_DATABASE`, `CORPUS_USER`, `CORPUS_PASSWORD`, `ENVELOPE_KMS_KEY_ID`, `STATE_SIGNING_SECRET` (≥ 32 bytes).

Defaults: `AWS_REGION=us-west-2` (env-driven with `CDK_DEFAULT_REGION` / `AWS_REGION` first), `CLASSIFIER_MODEL_ID=us.anthropic.claude-sonnet-4-6-20250514-v1:0`, `EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0`, `APPLICABILITY_AUTO_ALERT_THRESHOLD=80`, `APPLICABILITY_REVIEW_THRESHOLD=50`, `CRAWL_CONCURRENCY=2`, `CLASSIFY_CONCURRENCY=5`, `PUBLISH_CONCURRENCY=2`, `AUDIT_CONCURRENCY=5`.

App secrets (Slack webhook, Notion/Confluence OAuth creds, Resend key, STATE_SIGNING_SECRET) live in AWS Secrets Manager at `watchtower/{env}/app-secrets`. Seeded with placeholders on CREATE; operators populate real values via `aws secretsmanager put-secret-value`. See `docs/secrets.md` (stub — coming in a follow-up).

## Conventions

Project conventions (Node 24, ESM `.js` import suffixes, strict TS with `exactOptionalPropertyTypes`, Zod at boundaries, structured JSON logging, port-based DI, OpenTelemetry as source of truth) come from the root `protohype/CLAUDE.md`.

Watchtower-specific:

- **Fail-secure in the classifier.** LLM error / timeout / schema mismatch → `disposition: review`, never `drop`. Enforced by `classifier.test.ts` with explicit "obviously irrelevant client still routes to review on failure" coverage.
- **Approval gate is the only path to publish.** `src/publish/approval-gate.ts` is the single sanctioned caller of `PublisherPort.publish()`. A CI grep-gate in `.github/workflows/watchtower-ci.yml` rejects any PR that adds a new call site outside the gate.
- **Dedup mark is LAST in the crawl handler.** Crashing mid-flight replays the change next cycle rather than losing it.
- **Audit writes propagate failures.** SQS throws bubble up — compliance records are not best-effort.
- **`AsyncLocalStorage` trace context.** Every job processed through the consumer is scoped by `withTraceContext`; logger mixes `traceId` in automatically.
- **Per-source circuit breakers.** The HTTP fetcher in `src/crawlers/http.ts` opens on 5 consecutive failures per source and probes via half-open.

## Testing

14 test files, 106 tests, colocated as `src/**/*.test.ts`. Run with `npm test`. Coverage gates are opt-in via `npm run test:coverage` — will land with explicit thresholds in a follow-up.

Critical-path coverage:

- `src/classifier/classifier.test.ts` — every disposition path + every fail-secure path + threshold validation.
- `src/publish/approval-gate.test.ts` — every gate decision branch: missing memo, every non-approved status, inactive client, no destination, publisher error, state race.
- `src/handlers/handlers.test.ts` — full per-stage flows with in-memory queues and fakes.
- `src/audit/audit.test.ts` — schema validation, FIFO group/dedup id formation, error propagation.

**Never `vi.mock(<sdk-package>)`.** Every external service is injected as a typed port; tests use fakes implementing the port. AWS SDK clients accept `{ send: vi.fn() }` directly (the SDK has no module-level mutable state that requires client-level mocking). The rule is grep-enforced in the follow-up eval-harness CI pass.

When adding a new handler or domain module: accept the SDK client / port as a typed dep on the source-side factory and write a colocated `*.test.ts` using fakes. The `audit/fake.ts`, `clients/fake.ts`, `memo/storage.ts`'s `FakeMemoStorage`, `publish/fake.ts`, `crawlers/dedup.ts`'s `FakeDedup`, and `pipeline/fake.ts` cover most wiring scenarios.

## Dependencies

- `@aws-sdk/client-bedrock-runtime` — Bedrock Claude (LLM) + Titan (embeddings) on-account inference.
- `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` — clients, dedup, memos, audit hot table.
- `@aws-sdk/client-s3` — audit archive (currently only via the Lambda consumer).
- `@aws-sdk/client-sqs` — stage handoff queues + audit emit.
- `@opentelemetry/auto-instrumentations-node` — auto-traced http/fetch/aws-sdk/pg via Dockerfile `--require` hook.
- `fast-xml-parser` — RSS 2.0 / Atom parsing (zero transitive deps).
- `pg` + `@types/pg` — pgvector corpus via raw SQL (no ORM; cheaper for the simple schema).
- `hono` + `@hono/node-server` — health server.
- `zod` — env validation + every schema at every boundary.

The HTTP boundary uses native `fetch` (Node 24's WHATWG implementation) throughout — no axios, no `node-fetch`.

## Reference docs (`docs/`)

- [`docs/threat-model.md`](docs/threat-model.md) — STRIDE threat model + abuse scenarios.
- [`docs/runbook.md`](docs/runbook.md) — operator runbook.
- [`docs/integrations.md`](docs/integrations.md) — every third-party integration (Bedrock, DDB, SQS, pgvector, Notion, Confluence, Slack, Resend) with env vars and verification.

## Evals (`eval/`)

- [`eval/applicability-classifier-precision.yaml`](eval/applicability-classifier-precision.yaml) — labeled `(rule-change, client-config, expected-applicable)` tuples. Gates the classifier threshold.

More suites in the next follow-up: `memo-drafter-rubric`, `dedup-no-regress`.
