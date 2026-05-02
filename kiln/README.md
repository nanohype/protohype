# kiln

Dependency-upgrade automation. Where Renovate and Dependabot bump the version and link the changelog, **kiln reads the vendor changelog, identifies breaking changes against each tenant's specific codebase, applies the mechanical patches, and opens a GitHub PR with the migration work already done.**

## What This Is

A protohype project composing nanohype templates (`ts-service`, `infra-aws`, `module-llm`, `prompt-library`) into a CDK-deployed multi-Lambda service: one HTTP API for team administration, one scheduled poller, one SQS-consumer worker that runs the upgrade pipeline.

**Not a template** — this is a standalone service. Infra-as-code in `infra/`, app code in `src/`, test suites in `tests/`. Forkable for a different client by swapping secrets, DynamoDB table names, GitHub App, and WorkOS project without touching application code — see [`docs/forking-for-a-new-client.md`](docs/forking-for-a-new-client.md).

## How It Works

```
npm registry  ──►  Poller Lambda (EventBridge cron 15m)
                         │
                         ▼  enqueue per watched dep (one team row → N jobs)
                   SQS FIFO (group-id = team:repo:pkg, dedup = sha256(team|repo|pkg|from|to))
                         │
                         ▼
                   Worker Lambda (batchSize=1, reportBatchItemFailures)
                   ├── 1. Idempotency check in PR ledger (early exit on duplicate)
                   ├── 2. Token acquire from DDB-backed rate bucket (per-team)
                   ├── 3. Changelog fetch (domain-allowlist SSRF guard + DDB cache)
                   ├── 4. Classify breaking changes via Claude Haiku 4.5 (Bedrock)
                   ├── 5. GitHub code search for call sites
                   ├── 6. Synthesize patches via Claude Sonnet 4.6 (Opus escalation on low confidence)
                   ├── 7. Open PR via GitHub App installation token
                   └── 8. Record in PR ledger + close audit record
                         │
                         ▼
                   DynamoDB (team-config, pr-ledger [idempotency], audit-log [PITR + deletion-protection],
                             changelog-cache [TTL + global], rate-limiter, github-token-cache)
                         │
                         ▼
                   GitHub (branch + commits + PR with migration notes, humans review)

Hono HTTP API (API Gateway + Lambda, WorkOS JWT authorizer) for team admin.
CloudWatch alarms → SNS topic "kiln-alarms" (subscribe email/Slack operationally).
AWS Config rule asserts Bedrock inference logging stays disabled; drift alarms within minutes.
OTel → Grafana Cloud (Tempo/Mimir/Loki) opt-in via KILN_TELEMETRY_ENABLED=true; OTLP basic_auth fetched from Secrets Manager at cold start so the credential never touches Lambda env.
```

**Core invariant:** PR idempotency. `recordPrOpened` uses `ConditionExpression: attribute_not_exists(idempotencyKey)`, enforced at three layers:
1. **Application** — worker checks `findExistingPr` before opening; early-exits on hit.
2. **Database** — DynamoDB condition ensures only the first writer per digest succeeds.
3. **Transport** — SQS FIFO `MessageDeduplicationId` = the same sha256 digest, collapsing retries within a 5-minute window.

Plus: tenant isolation via nominal `TeamId` (cross-tenant reads are compile errors, not runtime checks), core/adapters boundary enforced by ESLint, Bedrock inference logging disabled account-wide + AWS Config rule asserting drift.

## Architecture

- **src/core/ports.ts** — 15 port interfaces. The architectural seam. Every side effect kiln performs flows through one of these; adapters implement them, callers depend on them. Every port method that touches tenant state requires a `TeamId`.
- **src/core/changelog/** — `allowlist.ts` (5-host SSRF guard: github.com, raw.githubusercontent.com, api.github.com, registry.npmjs.org, www.npmjs.com); `parser.ts` (markdown-ish changelog → per-version sections, handles `## [1.2.3]`, `## 1.2.3`, `## v1.2.3` variants).
- **src/core/grouping/strategy.ts** — Renovate-style grouping: per-dep, per-family (glob match like `@aws-sdk/*`), per-release-window. Pure dispatch on `strategy.kind` with exhaustive discriminated union.
- **src/core/github/** — `idempotency.ts` derives the sha256 digest + FIFO `messageGroupId`; `pr-body.ts` renders the PR title + branch name + body with migration notes citing changelog URLs and `file:line` call sites.
- **src/core/npm/policy.ts** — `semver`-based policy evaluation: `latest` | `minor-only` | `patch-only` plus skip-list.
- **src/core/ai/** — `prompts.ts` authors the classifier + synthesizer system/user prompts as pure strings; `guardrails.ts` validates LLM responses via zod schemas and tolerates Claude's occasional ```json fence wrapping.
- **src/core/audit/shape.ts** — audit-record builders: `newAuditRecord`, `advance`, `withPr`, `withError`. Stamp `finishedAt` only on terminal statuses.
- **src/core/notifications/templates.ts** — Slack Block Kit JSON shapes for PR-opened + failure notifications. Pure; Slack SDK lives in the adapter.
- **src/adapters/dynamodb/** — per-table adapters. `team-config.ts`, `pr-ledger.ts` (conditional write for idempotency), `audit-log.ts`, `rate-limiter.ts` (conditional `UpdateItem` token bucket, thread-safe across Lambda instances), `changelog-cache.ts` (globally shared, see [ADR 0005](docs/adr/0005-global-changelog-cache.md)), `github-token-cache.ts` (installation-token cache with 50-min cap for 60-min tokens), `client.ts` (shared `DynamoDBDocumentClient`; honors `AWS_ENDPOINT_URL_DYNAMODB` for DDB-Local).
- **src/adapters/bedrock/client.ts** — Bedrock wrapper. Hard-capped timeout via `AbortController`. Transport errors return `Upstream`/`Timeout`; schema failures return `Validation`. No throws cross the port.
- **src/adapters/github-app/client.ts** — `@octokit/auth-app` for installation tokens (DDB-cached), `@octokit/rest` for branch/commit/PR ops. Separate `makeCodeSearchAdapter` wraps the code-search API per breaking-change symbol.
- **src/adapters/changelog-fetcher/client.ts** — HTTPS fetch with allowlist check BEFORE the request, explicit `AbortController` timeout.
- **src/adapters/npm-registry/client.ts** — public npm packument fetch, extracts `dist-tags.latest` + per-version repository URL.
- **src/adapters/secrets-manager/client.ts** — module-scope cache with TTL ≤ half the credential lifetime. GitHub App PEM flows through here; value never logged, never env-injected.
- **src/adapters/workos-authkit/verifier.ts** — `jose`-backed JWKS verify against WorkOS AuthKit. Audience (clientId) + issuer pinned at adapter construction. `teamId` from a dedicated WorkOS custom claim (default `kiln_team_id`), never from `sub` or email prefix.
- **src/telemetry/init.ts** — programmatic OTel NodeSDK started in Lambda cold start. OTLP basic_auth fetched from Secrets Manager so the credential never lives in Lambda env. Best-effort: init failure logs a warning and the handler continues without tracing.
- **src/telemetry/tracing.ts** — `withSpan` wrapper + SQS MessageAttributes ↔ W3C trace-context helpers. Traces propagate poller → SQS → worker as a single span tree in Grafana Cloud Tempo.
- **src/telemetry/metrics.ts** — `MetricsEmitter` via OTel Metrics API. Counters + histograms (`kiln_classify_duration_ms`, `kiln_pr_opened_count`, `kiln_ledger_desync_count`, etc.) flow to Grafana Cloud Mimir.
- **src/adapters/sqs/queue.ts** — sends upgrade jobs with `messageGroupId = teamId:repo:pkg`, `MessageDeduplicationId = sha256 digest`.
- **src/adapters/slack/notifications.ts** — Slack incoming-webhook POSTs. Silent no-op if webhook URL unset.
- **src/adapters/compose.ts** — composition root. Builds the full production `Ports` bundle in one place; handlers import this, not the individual adapters.
- **src/api/app.ts** — Hono factory. Same code runs inside Lambda (via `@hono/aws-lambda`) and locally (via `@hono/node-server`). Mounts `/healthz`, `/readyz` (public), and `/teams/:teamId/*` (auth + tenant-scope middleware).
- **src/api/middleware/** — `auth.ts` verifies the bearer via the IdentityPort (WorkOS-backed) and stashes `VerifiedIdentity` on Hono context; `tenant-scope.ts` enforces URL `:teamId` == JWT claim; `error-mapper.ts` translates `DomainError` → HTTP status.
- **src/api/routes/** — `health.ts`, `teams.ts` (CRUD with zod-validated body), `upgrades.ts` (list recent PRs for the caller's team).
- **src/workers/poller.ts** — polls every team's watched deps sequentially, enqueues jobs through the UpgradeQueuePort. Pure — takes `Ports` as its only argument.
- **src/workers/upgrader.ts** — the 8-step pipeline. Every step between audit records is `await`ed. `retryWrite` with exponential backoff guards the PR-ledger write-after-PR-open case; on exhaustion, writes a `ledger-desync` audit record with the PR URL and an `alert` tag for ops.
- **src/handlers/** — Lambda entrypoints. `api.ts` wraps the Hono app via `@hono/aws-lambda`. `poller.ts` takes an EventBridge event. `upgrader.ts` takes an `SQSEvent`, returns `SQSBatchResponse` with `reportBatchItemFailures`.
- **src/local.ts** — local dev server. Runs the Hono API on `:3000` plus a `setInterval` poller. Points DDB at DynamoDB Local via `AWS_ENDPOINT_URL_DYNAMODB`.
- **src/config.ts** — zod-validated env at startup. Missing/malformed values fail the cold start loudly.
- **src/types.ts** — nominal types (`TeamId`, `UpgradeId`, `InstallationId`), domain value types, `Result<T, E>`, `DomainError` discriminant union.
- **src/logger.ts** — structured JSON to stderr. `child({ teamId, upgradeId })` threads correlation IDs.
- **src/registry.ts** — provider registry pattern (mirrored from sigint) for future swap-points.
- **infra/lib/kiln-stack.ts** — CDK stack. Composes 7 single-responsibility constructs.
- **infra/lib/constructs/storage-construct.ts** — 6 DynamoDB tables + 1 FIFO SQS + 1 DLQ. PITR + deletion-protection on the three auditable tables. Exports `sharedEnv()` for propagation into Lambda functions.
- **infra/lib/constructs/secrets-construct.ts** — GitHub App PEM in Secrets Manager (`RemovalPolicy.RETAIN`).
- **infra/lib/constructs/bedrock-construct.ts** — sets `CfnModelInvocationLoggingConfiguration(loggingEnabled=false)` + AWS Config rule `kiln-bedrock-inference-logging-disabled`. Depends on a dedicated sub-account; [ADR 0003](docs/adr/0003-dedicated-aws-subaccount.md) explains.
- **infra/lib/constructs/api-construct.ts** — HTTP API Gateway + WorkOS JWT authorizer (`HttpJwtAuthorizer` pointed at WorkOS issuer + clientId) + api Lambda. Empty `allowOrigins` by default (machine-to-machine).
- **infra/lib/constructs/poller-construct.ts** — poller Lambda + EventBridge cron.
- **infra/lib/constructs/worker-construct.ts** — worker Lambda + SQS event source + Bedrock + GitHub IAM. **No** `reservedConcurrentExecutions` — FIFO group-id fairness handles per-team serialization without starving other teams. [ADR 0001](docs/adr/0001-fifo-group-id-tuple.md).
- **infra/lib/constructs/observability-construct.ts** — SNS alarm topic + CloudWatch alarms (DLQ depth, Bedrock logging drift).
- **infra/lib/constructs/lambda-factory.ts** — shared Lambda factory. Every kiln Lambda flows through it so runtime, architecture, bundling, and log retention stay consistent.
- **infra/bin/kiln.ts** — CDK app entrypoint. Reads `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`, instantiates `KilnStack`.

## Run locally

```bash
cp .env.example .env           # fill in values — see "Configuration" below
npm install
npm run typecheck
npm run lint
npm run test:unit              # pure tests — no Docker
npm run test:integration       # real DDB via testcontainers
npm run local                  # Hono API on :3000 + background poller
```

`npm run local` expects live AWS credentials (for Bedrock + Secrets Manager) and a reachable WorkOS JWKS endpoint (outbound `https://api.workos.com`). DynamoDB can be pointed at DynamoDB Local via `AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000`; there is no pure-offline mode for Bedrock or GitHub.

## Test

```bash
npm test                           # unit + integration
npm run test:unit                  # pure core/ tests, no Docker
npm run test:integration           # spins DynamoDB Local via testcontainers
npm run test:evals                 # Bedrock eval harness, gated by KILN_RUN_EVALS=1
npm run typecheck                  # src + infra
npm run lint                       # ESLint 10 flat config
npm run format                     # Prettier --check
```

Coverage gate ≥ 70% lines / functions / branches on the `src/` tree. See § Testing for the trophy distribution.

## Build

```bash
npm run build                      # tsc → dist/
```

## Deploy

Single stack per environment (`KilnStack`). Staging and production live in separate AWS sub-accounts — separate GitHub Apps, separate secrets, separate IAM. The staging role cannot read production secrets.

```bash
npm run cdk:synth                  # catches most misconfigurations pre-AWS
npm run cdk:diff                   # preview
npm run cdk:deploy                 # ~6 min first deploy (Lambda bundling)
```

Requires Docker running locally, AWS CLI creds for the target sub-account, Bedrock model access enabled in-console (Haiku 4.5, Sonnet 4.6, Opus 4.6 in `us-west-2` AND `us-east-1`). First-time deployers: seed secrets BEFORE `cdk deploy` — see [`docs/deployment-guide.md`](docs/deployment-guide.md).

**Forking for a new client** — separate AWS account, separate GitHub App, optional `KILN_RESOURCE_PREFIX` to namespace table/queue/function names — [`docs/forking-for-a-new-client.md`](docs/forking-for-a-new-client.md).

**Secret seeding + rotation** — env-scoped inventory (`kiln/{env}/github-app-private-key`, etc.), `put-secret-value` commands, rotation cadence — [`docs/secrets.md`](docs/secrets.md).

**Post-deploy** — `docs/drills.md` § "Minimal happy-path drill" (5-step copy-paste, <2 minutes). Run after every `cdk:deploy`. If any step fails, [`docs/troubleshooting.md`](docs/troubleshooting.md) is symptom-keyed.

## Configuration

All configuration via env vars (validated by `src/config.ts` via zod at Lambda cold start). In Lambda, env vars are set by CDK at deploy (table names, queue URL, secret ARNs) or by operator-edited env context (WorkOS issuer + clientId, GitHub App ID). `.env.example` is for local dev only.

| Variable | Source | Purpose |
|---|---|---|
| `KILN_ENV` | CDK env | `dev` / `staging` / `production` |
| `KILN_LOG_LEVEL` | CDK env | `debug` / `info` / `warn` / `error` |
| `KILN_REGION` | CDK env | AWS region (defaults to `us-west-2`) |
| `KILN_WORKOS_ISSUER` | CDK env | WorkOS OIDC issuer URL; typically `https://api.workos.com` |
| `KILN_WORKOS_CLIENT_ID` | CDK env | WorkOS client ID; used as the JWT audience |
| `KILN_WORKOS_JWKS_URL` | CDK env (optional) | Override; default is `${issuer}/sso/jwks/${clientId}` |
| `KILN_WORKOS_TEAM_CLAIM` | CDK env | WorkOS custom claim carrying `teamId` (default `kiln_team_id`) |
| `KILN_WORKOS_API_KEY` | secret (optional) | WorkOS Management API key; unused in v1 |
| `KILN_GITHUB_APP_ID` | CDK env | Numeric App ID from GitHub |
| `KILN_GITHUB_APP_SECRET_ARN` | CDK env | Secrets Manager ARN for the PEM |
| `KILN_TEAM_CONFIG_TABLE`, `KILN_PR_LEDGER_TABLE`, `KILN_AUDIT_LOG_TABLE`, `KILN_CHANGELOG_CACHE_TABLE`, `KILN_RATE_LIMITER_TABLE`, `KILN_GITHUB_TOKEN_CACHE_TABLE` | **set by CDK** | DynamoDB table names, injected at deploy |
| `KILN_UPGRADE_QUEUE_URL` | **set by CDK** | SQS FIFO queue URL |
| `KILN_BEDROCK_REGION`, `KILN_BEDROCK_CLASSIFIER_MODEL`, `KILN_BEDROCK_SYNTHESIZER_MODEL`, `KILN_BEDROCK_SYNTHESIZER_ESCALATION_MODEL` | CDK env | Bedrock model IDs + region |
| `KILN_NPM_TIMEOUT_MS`, `KILN_CHANGELOG_TIMEOUT_MS`, `KILN_GITHUB_TIMEOUT_MS`, `KILN_BEDROCK_TIMEOUT_MS`, `KILN_SECRETS_TIMEOUT_MS` | CDK env | Per-call timeouts — every external call is explicit |
| `KILN_GITHUB_RATE_CAPACITY`, `KILN_GITHUB_RATE_REFILL_PER_SEC` | CDK env | Token bucket parameters for the per-team GitHub rate limiter |
| `KILN_POLLER_INTERVAL_MINUTES` | CDK env | Must match the EventBridge rule cadence |
| `KILN_TELEMETRY_ENABLED` | CDK env | Opt-in `true`/`false`. Off = CloudWatch-only; on = Grafana Cloud via OTLP |
| `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_METRIC_EXPORT_INTERVAL` | CDK env | Standard OTel knobs; endpoint is the Grafana Cloud OTLP gateway |
| `KILN_GRAFANA_CLOUD_OTLP_SECRET_ARN` | CDK env | Secrets Manager ARN for `{ instance_id, api_token, basic_auth }` |
| `KILN_SLACK_WEBHOOK_URL` | secret `kiln/{env}/slack/webhook-url` (optional) | Alarm destination for per-tenant PR notifications |
| `AWS_ENDPOINT_URL_DYNAMODB` | local dev only | DynamoDB Local URL |

The DynamoDB Document client (`src/adapters/dynamodb/client.ts`) honors `AWS_ENDPOINT_URL_DYNAMODB` so integration tests and local dev can point at a non-AWS endpoint without touching adapter code.

## Conventions

Per root `protohype/CLAUDE.md`: TypeScript, ESM (`.js` import suffixes), Node 24, 2-space indent, strict TS (`exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`), zod at system boundaries, structured JSON logging to stderr, Vitest for tests, ESLint + typescript-eslint flat config.

kiln-specific:
- **`core/` is pure.** No `@aws-sdk/*`, `@octokit/*`, `hono`, `jose`, or `src/adapters/**` imports. Enforced by ESLint `no-restricted-imports` in `eslint.config.mjs`. [ADR 0002](docs/adr/0002-hexagonal-core-adapters-split.md).
- **Nominal types for tenant isolation.** `TeamId` is branded; every port method that touches tenant data requires it. Cross-tenant reads are compile errors, not runtime checks that could be forgotten.
- **Audit writes are awaited.** `@typescript-eslint/no-floating-promises: error` enforces this. A fire-and-forget audit write is a security bug, not a style issue.
- **Errors are values at adapter boundaries.** Adapters return `Result<T, DomainError>`; no thrown exceptions cross the port. `src/api/middleware/error-mapper.ts` translates `DomainError.kind` to HTTP status.
- **Every external call is timeboxed.** Timeouts live in `src/config.ts`; adapters thread them via `AbortController`. Unbounded `fetch` is a defect.
- **No reserved Lambda concurrency.** FIFO group-id fanout (`teamId:repo:pkg`) provides per-tuple serialization while letting unrelated work run concurrently. A global cap would be a tenant fairness bomb. [ADR 0001](docs/adr/0001-fifo-group-id-tuple.md).

## Testing

Trophy-shaped: heavy on static analysis and integration tests, light on pure unit, minimal on full E2E.

### Test matrix

| Tier | Files | What they exercise |
|---|---|---|
| Static | `tsconfig.json` strict + `eslint.config.mjs` + `.prettierrc.json` | Types, lint rules (no floating promises, no-explicit-any, no-restricted-imports on core/), consistent format |
| Unit | `tests/unit/**/*.test.ts` | Pure core/ functions: changelog parser, allowlist, grouping, npm policy, idempotency, audit shape, notification templates, AI guardrails |
| Integration | `tests/integration/**/*.test.ts` | Real DynamoDB Local via testcontainers: cross-tenant isolation, rate-limiter concurrency, full pipeline with fake LLM + fake GitHub |
| Evals | `tests/evals/**/*.eval.test.ts` | LLM prompt evals against Bedrock, gated by `KILN_RUN_EVALS=1`. F1 rubric on a seed corpus (React 19, Zod 4, Prisma 6, Next 15) |

### Coverage

Global 70% branches / lines / functions / statements on `src/` (enforced in `vitest.config.ts`). `src/adapters/dynamodb/rate-limiter.ts`, `src/core/github/idempotency.ts`, and the composition root carry the load-bearing invariants; regressions there must land with new tests.

### Adding tests

- Pure core logic → `tests/unit/`. No I/O. Fakes for any port dependency.
- DynamoDB semantics (consistency, condition expressions, GSI) → `tests/integration/`. Uses real DDB Local.
- LLM prompt changes → `tests/evals/fixtures/changelogs/` + re-run the F1 harness.

## Dependencies

| Package | Why |
|---|---|
| `hono`, `@hono/aws-lambda`, `@hono/node-server` | HTTP framework. Same code in Lambda + local dev |
| `@octokit/auth-app`, `@octokit/rest` | GitHub App installation tokens + REST API |
| `jose` | ESM-native JWKS + JWT verify (unlike `jsonwebtoken`) |
| `zod` | Boundary validation: env, HTTP bodies, LLM outputs |
| `semver` | Version policy evaluation |
| `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` | Team config, PR ledger, audit log, rate limiter, changelog cache, token cache |
| `@aws-sdk/client-sqs` | Upgrade job queue (FIFO) |
| `@aws-sdk/client-secrets-manager` | GitHub App PEM, optional Slack webhook |
| `@aws-sdk/client-bedrock-runtime` | `claude-haiku-4-5` classifier + `claude-sonnet-4-6` / `claude-opus-4-6` synthesizer |
| `@slack/web-api` | Webhook-style Slack notifications (optional) |
| `aws-sdk-client-mock` (dev) | AWS SDK mocks for unit tests |
| `testcontainers` (dev) | DynamoDB Local for integration tests |
| `aws-cdk-lib`, `constructs` | Infrastructure as code |

No heavy AI frameworks (no LangChain) — direct Bedrock SDK with prompt authoring in `src/core/ai/prompts.ts`.

## Docs

Operator-facing:

| Document | Path |
|---|---|
| Deployment guide (step-by-step, first-time) | [docs/deployment-guide.md](docs/deployment-guide.md) |
| GitHub App setup (one-time per env) | [docs/github-app-setup.md](docs/github-app-setup.md) |
| WorkOS AuthKit setup (one-time per env) | [docs/workos-setup.md](docs/workos-setup.md) |
| Grafana Cloud setup (OTel traces/metrics/logs) | [docs/grafana-cloud-setup.md](docs/grafana-cloud-setup.md) |
| Secrets inventory + seeding + rotation | [docs/secrets.md](docs/secrets.md) |
| Drills + "how do I see it work" | [docs/drills.md](docs/drills.md) |
| Troubleshooting catalogue | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Forking kiln for a new client | [docs/forking-for-a-new-client.md](docs/forking-for-a-new-client.md) |
| On-call runbook (day-2) | [docs/runbook.md](docs/runbook.md) |
| Threat model | [docs/threat-model.md](docs/threat-model.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |

Architecture decision records:

| ADR | Topic |
|---|---|
| [0001](docs/adr/0001-fifo-group-id-tuple.md) | FIFO group-id scoped to (team, repo, pkg) |
| [0002](docs/adr/0002-hexagonal-core-adapters-split.md) | Hexagonal core/adapters split, ESLint-enforced |
| [0003](docs/adr/0003-dedicated-aws-subaccount.md) | Dedicated AWS sub-account |
| [0004](docs/adr/0004-idempotency-key.md) | Idempotency key = sha256(teamId\|repo\|pkg\|fromVersion\|toVersion) |
| [0005](docs/adr/0005-global-changelog-cache.md) | Changelog cache is global, not per-tenant |
