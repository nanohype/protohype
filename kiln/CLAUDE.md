# kiln

Dependency-upgrade automation — reads the changelog, classifies breaking changes, patches call sites, opens a GitHub App PR.

## What This Is

A protohype subsystem composing nanohype templates (`ts-service` worker-service + `infra-aws` CDK + `module-llm` Bedrock wrapper + `prompt-library` patterns) into a three-Lambda service: HTTP API for team admin (Hono + API Gateway), scheduled poller (EventBridge cron), SQS FIFO consumer (the upgrader pipeline).

Fork me for a different client by swapping secrets, DynamoDB table names, GitHub App, and WorkOS project. Port-based DI is load-bearing — every external call goes through a constructor-injected adapter, not a module import. End-to-end walkthrough in `docs/forking-for-a-new-client.md`.

## How It Works

EventBridge fires the poller every 15 min → for each team row, for each watched dep, query npm → if an upgrade is eligible under the team's `targetVersionPolicy`, enqueue to SQS FIFO (group-id `teamId:repo:pkg`, dedup-id = sha256 of the full upgrade tuple) → SQS delivers to the worker Lambda one message at a time.

The worker runs the 8-step upgrade pipeline:
1. **Idempotency** — check PR ledger; skip if a PR already exists for this digest.
2. **Rate acquire** — DDB-backed token bucket, scoped per team.
3. **Changelog** — fetch via domain-allowlisted HTTPS (SSRF guard), cache in DDB for 7 days.
4. **Classify** — Claude Haiku 4.5 extracts breaking changes; guardrail parses the JSON and fails the step cleanly on schema drift.
5. **Code search** — GitHub App + code-search API per breaking-change symbol.
6. **Synthesize** — Claude Sonnet 4.6 writes patches; Opus 4.6 escalation when the classifier confidence was < 0.7.
7. **Open PR** — GitHub App installation token (DDB-cached), branch + commits + PR with migration notes citing changelog URLs + `file:line` call sites.
8. **Ledger + audit** — `recordPrOpened` (conditional write) then audit `pr-opened`. If the ledger write fails after three retries the audit flips to `ledger-desync` with the PR URL included; the alert tag surfaces to ops.

Every step between audit records is `await`ed; the API boundary returns `Result<T, DomainError>` so exceptions never cross the port. Hono middleware chains auth (WorkOS JWT via remote JWKS) → tenant-scope (URL `:teamId` must match JWT claim) → handler.

Telemetry is opt-in (`KILN_TELEMETRY_ENABLED=true`). When on, the Lambda cold start fetches the Grafana Cloud OTLP `basic_auth` from Secrets Manager and initializes the OTel NodeSDK — traces land in Tempo, metrics in Mimir, logs in Loki. When off, structured JSON stderr logs flow to CloudWatch and CloudWatch alarms fire as usual.

## Architecture

- **src/core/ports.ts** — 15 port interfaces. The only thing callers in api/workers/handlers import from. Every port method touching tenant state requires `TeamId`.
- **src/core/changelog/** — allowlist (`github.com`, `raw.githubusercontent.com`, `api.github.com`, `registry.npmjs.org`, `www.npmjs.com` — HTTPS only) and parser (newest-first markdown sections).
- **src/core/grouping/strategy.ts** — Renovate-style per-dep / per-family (glob) / per-release-window. Exhaustive discriminated union.
- **src/core/github/idempotency.ts** — sha256 digest + FIFO group-id + dedup-id derivation. ADR 0004.
- **src/core/github/pr-body.ts** — PR title, branch name, body template with migration notes citing changelog URLs + call sites.
- **src/core/npm/policy.ts** — `semver`-based policy gate + skip-list check.
- **src/core/ai/prompts.ts** — pure prompt authoring (classifier + synthesizer). No SDK imports.
- **src/core/ai/guardrails.ts** — zod schemas for LLM output. Tolerates ```json fences.
- **src/core/audit/shape.ts** — audit-record builders (`newAuditRecord`, `advance`, `withPr`, `withError`). Pure; writes happen in the adapter.
- **src/core/notifications/templates.ts** — Slack Block Kit JSON shapes.
- **src/adapters/dynamodb/client.ts** — shared `DynamoDBDocumentClient`. Honors `AWS_ENDPOINT_URL_DYNAMODB` for DDB Local.
- **src/adapters/dynamodb/team-config.ts** — `teamId` PK. `list()` is poller-only; IAM scopes `dynamodb:Scan` to the poller role.
- **src/adapters/dynamodb/pr-ledger.ts** — composite key `(teamId, idempotencyKey)`. `recordPrOpened` uses `ConditionExpression: attribute_not_exists` for idempotency.
- **src/adapters/dynamodb/audit-log.ts** — composite key `(teamId, sk=upgradeId#startedAt)`. PITR + deletion-protection on the table.
- **src/adapters/dynamodb/rate-limiter.ts** — conditional-`UpdateItem` token bucket with 5-retry bounded loop. Thread-safe across Lambda instances.
- **src/adapters/dynamodb/changelog-cache.ts** — globally shared by design (public data); TTL via the DDB TTL attribute. ADR 0005.
- **src/adapters/dynamodb/github-token-cache.ts** — installation-token cache with 50-min cap for 60-min tokens. Shared across Lambda cold starts.
- **src/adapters/bedrock/client.ts** — Bedrock wrapper. `AbortController` timeout; transport errors → `Upstream`/`Timeout`, schema errors → `Validation`. No throws.
- **src/adapters/github-app/client.ts** — `@octokit/auth-app` mints installation tokens (through the DDB cache), `@octokit/rest` does branch/commit/PR ops. Separate `makeCodeSearchAdapter` wraps code-search per symbol.
- **src/adapters/changelog-fetcher/client.ts** — HTTPS fetch, allowlist checked BEFORE the request, explicit `AbortController` timeout.
- **src/adapters/npm-registry/client.ts** — public npm packument fetch.
- **src/adapters/secrets-manager/client.ts** — module-scope cache, TTL half the credential lifetime.
- **src/adapters/workos-authkit/verifier.ts** — `jose` + remote WorkOS JWKS (default `${issuer}/sso/jwks/${clientId}`). Audience (clientId) + issuer pinned at construction. `teamId` from a custom claim (default `kiln_team_id`), never from `sub` or email.
- **src/telemetry/init.ts** — programmatic OTel NodeSDK. Memoized, best-effort. Fetches Grafana Cloud basic_auth from Secrets Manager at cold start — credential never touches Lambda env. If init fails, Lambda keeps running without tracing.
- **src/telemetry/tracing.ts** — `withSpan` wrapper + SQS MessageAttributes ↔ W3C trace-context helpers. Poller → SQS → worker traces are a single span tree.
- **src/telemetry/metrics.ts** — `MetricsEmitter` + canonical metric names (`kiln_upgrader_total_duration_ms`, `kiln_pr_opened_count`, `kiln_ledger_desync_count`, `kiln_bedrock_throttle_count`, ...). Kept in lockstep with Grafana dashboard panel names.
- **src/adapters/sqs/queue.ts** — FIFO send with `messageGroupId = teamId:repo:pkg`, `MessageDeduplicationId = idempotencyDigest`.
- **src/adapters/slack/notifications.ts** — webhook POST. Silent no-op if URL unset.
- **src/adapters/compose.ts** — composition root. The one place that knows which adapter implements which port in production. Tests construct their own `Ports` from `tests/fakes.ts`.
- **src/api/app.ts** — Hono factory. Same code in Lambda + local dev.
- **src/api/middleware/auth.ts** — verifies bearer via `IdentityPort`, stashes `VerifiedIdentity` on context.
- **src/api/middleware/tenant-scope.ts** — enforces URL `:teamId` == JWT claim.
- **src/api/middleware/error-mapper.ts** — `DomainError.kind` → HTTP status.
- **src/api/routes/teams.ts** — zod-validated CRUD on `TeamConfig`.
- **src/api/routes/upgrades.ts** — list recent PRs for the caller's team.
- **src/workers/poller.ts** — pure function on `Ports`. Returns metrics `{ teamsScanned, depsChecked, enqueued, skipped, errors }`.
- **src/workers/upgrader.ts** — the 8-step pipeline. `retryWrite` helper with exponential backoff guards the ledger write-after-PR-open. `ledger-desync` audit on retry exhaustion.
- **src/handlers/api.ts** — Lambda entrypoint via `@hono/aws-lambda`. Composition happens at cold start.
- **src/handlers/poller.ts** — EventBridge-triggered Lambda handler.
- **src/handlers/upgrader.ts** — SQS-triggered Lambda handler. Returns `SQSBatchResponse` with `reportBatchItemFailures`.
- **src/local.ts** — local dev server. Hono API on :3000 + setInterval poller.
- **src/config.ts** — zod-validated env. Fail-fast at cold start.
- **src/types.ts** — nominal types, domain values, `Result<T, E>`, `DomainError`.
- **src/logger.ts** — JSON to stderr. `.child({ teamId, upgradeId })` for correlation.
- **src/registry.ts** — provider registry (sigint pattern). Reserved for future swap-points.
- **infra/bin/kiln.ts** — CDK app entrypoint.
- **infra/lib/kiln-stack.ts** — composes the 7 constructs. Nothing else lives in the stack file.
- **infra/lib/constructs/storage-construct.ts** — 6 DDB tables + FIFO queue + DLQ. Exports `sharedEnv()`.
- **infra/lib/constructs/secrets-construct.ts** — GitHub App PEM.
- **infra/lib/constructs/bedrock-construct.ts** — `loggingEnabled=false` + AWS Config rule to alarm on drift.
- **infra/lib/constructs/api-construct.ts** — HTTP API Gateway + WorkOS JWT authorizer (`HttpJwtAuthorizer` pointed at WorkOS issuer + clientId) + api Lambda. Empty `allowOrigins` (machine-to-machine).
- **infra/lib/constructs/poller-construct.ts** — poller Lambda + EventBridge cron.
- **infra/lib/constructs/worker-construct.ts** — worker Lambda + SQS source. No reservedConcurrentExecutions.
- **infra/lib/constructs/observability-construct.ts** — SNS alarm topic + DLQ-depth alarm + Bedrock-logging-drift alarm.
- **infra/lib/constructs/lambda-factory.ts** — shared Lambda factory for consistent runtime/arch/bundling/log retention.
- **tests/fakes.ts** — in-memory implementations of every port. Unit + integration tests mount these by default.
- **tests/unit/** — pure core/ tests. No I/O.
- **tests/integration/** — DynamoDB Local via testcontainers. `cross-tenant-isolation`, `rate-limiter` concurrency, full `upgrader-pipeline`.
- **tests/evals/** — LLM prompt evals against Bedrock, gated by `KILN_RUN_EVALS=1`. F1 rubric on a seed corpus (React 19, Zod 4, Prisma 6, Next 15).

## Commands

```bash
npm ci
npm run lint
npm run format                     # Prettier --check
npm run typecheck                  # tsc --noEmit for src + infra
npm run build                      # tsc → dist/
npm run test                       # unit + integration
npm run test:unit                  # no Docker required
npm run test:integration           # spins DynamoDB Local via testcontainers
npm run test:evals                 # Bedrock harness, requires KILN_RUN_EVALS=1
npm run local                      # Hono API on :3000 + background poller
npm run cdk:synth
npm run cdk:diff
npm run cdk:deploy
```

## Configuration

All config via env vars, zod-validated in `src/config.ts` at Lambda cold start. See the Configuration table in `README.md` and `docs/secrets.md` for the full inventory + provenance. Secrets live in Secrets Manager at `kiln/{env}/*` and are cached in-process for ≤5 minutes — rotation reaches running Lambdas without redeploy.

Table names, queue URL, secret ARNs: **set by CDK** at deploy time. Do not override them in operator env.

WorkOS issuer + clientId + team-claim: operator-controlled via CDK synth-time env. Changing them is a config change, not a code change.

Grafana Cloud OTLP: `KILN_TELEMETRY_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` + `KILN_GRAFANA_CLOUD_OTLP_SECRET_ARN`. Signals opt-out by just flipping the flag; the init path short-circuits.

## Conventions

Per root `protohype/CLAUDE.md`: TypeScript, ESM (`.js` import suffixes), Node 24, 2-space indent, strict TS with `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`, zod at system boundaries, structured JSON logging to stderr, Vitest for tests, ESLint + typescript-eslint flat config.

kiln-specific:

- **`core/` is pure.** No `@aws-sdk/*`, `@octokit/*`, `hono`, `jose`, or `src/adapters/**` imports in `src/core/**`. Enforced by ESLint `no-restricted-imports`. ADR 0002.
- **Nominal types for tenant isolation.** `TeamId` is branded; every port method touching tenant data requires it. Cross-tenant reads are compile-time errors. Integration test `cross-tenant-isolation.test.ts` asserts the runtime behavior too.
- **Audit writes are awaited.** `@typescript-eslint/no-floating-promises: error` enforces this. Fire-and-forget audit is a security bug.
- **Errors are values.** Adapters return `Result<T, DomainError>`. Thrown exceptions from SDKs are caught at the adapter boundary and mapped to a `DomainError.kind` variant.
- **Every external call is timeboxed.** Timeouts live in `src/config.ts` (`npmMs`, `changelogMs`, `githubMs`, `bedrockMs`, `secretsMs`); adapters propagate them via `AbortController`. Unbounded `fetch` is a defect.
- **FIFO group-id = `${teamId}:${repo}:${pkg}`.** Scoped narrowly. A team with 200 pending upgrades across 200 packages fans out to 200 concurrent workers. Per-team cost ceiling enforced by the DDB token bucket, not by group-id. ADR 0001.
- **No reservedConcurrentExecutions.** A global cap is a tenant fairness bomb.
- **Port-based DI for subsystem reuse.** Every external service is accessed through an injected adapter. Forking kiln for a new client swaps adapter instances, not business logic.
- **Bedrock inference logging disabled account-wide.** CDK + AWS Config rule. Depends on dedicated sub-account. ADR 0003.
- **Changelog cache is global.** Changelogs are public data; partitioning per tenant would N-x storage for no security benefit. If private changelogs ever land, partition in a separate table. ADR 0005.

## Testing

### Test matrix

| Tier | Files | What they exercise |
|---|---|---|
| Static | `tsconfig.json` strict + `eslint.config.mjs` + `.prettierrc.json` | Types, no-floating-promises, no-explicit-any, no-restricted-imports (core purity), consistent format |
| Unit | `tests/unit/**/*.test.ts` | Pure core/: changelog parser, allowlist, grouping, npm policy, idempotency, audit shape, notification templates, AI guardrails, config validation |
| Integration | `tests/integration/**/*.test.ts` | Real DynamoDB Local (testcontainers): cross-tenant isolation, rate-limiter concurrency, full pipeline with fake LLM + fake GitHub |
| Evals | `tests/evals/**/*.eval.test.ts` | Bedrock. F1 on seed corpus (React 19, Zod 4, Prisma 6, Next 15). Gated by `KILN_RUN_EVALS=1` |

### Coverage

Global 70% branches / lines / functions / statements on `src/`. Enforced in `vitest.config.ts`.

Load-bearing files whose regressions must land with new tests: `src/adapters/dynamodb/rate-limiter.ts`, `src/adapters/dynamodb/pr-ledger.ts`, `src/core/github/idempotency.ts`, `src/workers/upgrader.ts`.

### Adding tests

- Pure core logic → `tests/unit/`. No I/O. Fakes for any port dependency.
- DynamoDB semantics (consistency, condition expressions) → `tests/integration/`.
- LLM prompt changes → add a fixture in `tests/evals/fixtures/changelogs/` + rerun the F1 harness. Target F1 ≥ 0.85.

## Dependencies

| Package | Why |
|---|---|
| `hono`, `@hono/aws-lambda`, `@hono/node-server` | HTTP framework. Same code in Lambda + local dev |
| `@octokit/auth-app`, `@octokit/rest` | GitHub App installation tokens + REST API (PR, branch, commit, code search) |
| `@workos-inc/node` | Reserved for WorkOS Management API server-side calls (unused in v1) |
| `jose` | ESM-native JWKS + JWT verify (used by the WorkOS adapter) |
| `@opentelemetry/sdk-node`, `@opentelemetry/api`, `@opentelemetry/api-logs` | OTel SDK for traces, metrics, logs |
| `@opentelemetry/exporter-{trace,metrics,logs}-otlp-http` | OTLP exporters targeting Grafana Cloud |
| `@opentelemetry/auto-instrumentations-node` | Zero-config http/fetch/aws-sdk spans |
| `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` | Resource attributes for service identity |
| `zod` | Boundary validation: env, HTTP bodies, LLM outputs |
| `semver` | Version policy evaluation |
| `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` | 6 tables |
| `@aws-sdk/client-sqs` | Upgrade job queue (FIFO) |
| `@aws-sdk/client-secrets-manager` | GitHub App PEM |
| `@aws-sdk/client-bedrock-runtime` | `claude-haiku-4-5` classifier, `claude-sonnet-4-6` / `claude-opus-4-6` synthesizer |
| `@slack/web-api` | Optional webhook notifications |
| `aws-sdk-client-mock` (dev) | AWS SDK mocks for unit tests |
| `testcontainers` (dev) | DynamoDB Local for integration tests |
| `aws-cdk-lib`, `constructs` | Infrastructure as code |

No LangChain / LlamaIndex / agent frameworks — direct Bedrock SDK calls with prompts authored in `src/core/ai/prompts.ts`.
