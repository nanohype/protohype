# Changelog

All notable changes to kiln. Semver'd; breaking changes call out migration steps. Dates are UTC.

## [Unreleased]

## [0.2.0] — 2026-04-23

### Breaking
- **Identity provider switched from Okta to WorkOS AuthKit.** `KILN_OKTA_ISSUER` / `KILN_OKTA_AUDIENCE` / `KILN_OKTA_TEAM_CLAIM` env vars are replaced by `KILN_WORKOS_ISSUER` / `KILN_WORKOS_CLIENT_ID` / `KILN_WORKOS_TEAM_CLAIM` (+ optional `KILN_WORKOS_JWKS_URL` override). WorkOS AuthKit issues standard OIDC JWTs so the verify code path is near-identical (`jose` + remote JWKS, audience + issuer pinned). Existing operators must re-configure a WorkOS custom claim named `kiln_team_id` (or whatever matches their env); see `docs/workos-setup.md`.
- **`src/adapters/okta-jwks/` removed.** Replaced by `src/adapters/workos-authkit/verifier.ts`.
- **Secrets inventory change:** `kiln/{env}/okta/client-credentials` (optional, reserved) is gone. Added `kiln/{env}/workos/api-key` (optional, reserved) and `kiln/{env}/grafana-cloud/otlp-auth` (required if telemetry is enabled).
- **`.env.example` placeholders changed.** Old Okta vars removed; new WorkOS + OTel vars added with safe defaults.

### Added
- **OpenTelemetry → Grafana Cloud** telemetry pipeline. Opt-in via `KILN_TELEMETRY_ENABLED=true`. Kiln runs fine without it — structured JSON logs still flow to CloudWatch; alarms still fire.
  - `src/telemetry/init.ts` — programmatic NodeSDK init at Lambda cold start. Fetches Grafana Cloud OTLP `basic_auth` from Secrets Manager so the credential never lives in Lambda env vars (matches marshal's pattern exactly).
  - `src/telemetry/tracing.ts` — `withSpan` wrapper + SQS MessageAttributes ↔ W3C trace-context helpers. Traces propagate poller → SQS → worker as a single span tree in Grafana Cloud Tempo.
  - `src/telemetry/metrics.ts` — `MetricsEmitter` over OTel Metrics API with ~15 canonical metric names (`kiln_upgrader_total_duration_ms{outcome}`, `kiln_pr_opened_count`, `kiln_ledger_desync_count`, `kiln_bedrock_throttle_count`, `kiln_rate_limiter_reject_count`, etc.). Kept in lockstep with Grafana dashboard panel names.
  - Logs: `src/logger.ts` is now dual-sink — JSON to stderr (CloudWatch fallback, grep-friendly for local dev) AND OTel LogRecord (Loki via OTLP Logs exporter when telemetry active). `trace_id` + `span_id` stamped automatically when a span is active.
  - Workers wrap pipeline steps in `withSpan`: `kiln.upgrader.run`, `kiln.classify`, `kiln.synthesize`, `kiln.pr_open`, `kiln.poller.cycle`.
  - SQS enqueue/consume propagate trace context via MessageAttributes so the full pipeline shows as one trace.

### Infra
- New CDK secret `kiln/grafana-cloud/otlp-auth` in `secrets-construct.ts` (RETAIN).
- All three Lambda roles (api, poller, worker) now include `secretsmanager:GetSecretValue` on the Grafana Cloud OTLP secret.
- API Gateway JWT authorizer now points at WorkOS issuer + clientId (`api-construct.ts`).
- Config schema in `src/config.ts` gained timeout-minimum (`≥100ms`), HTTPS-only URL validation, and a dedicated `telemetry` block.

### Tooling
- Seeder (`scripts/seed-secrets.sh`) now auto-computes `basic_auth` from `instance_id` + `api_token` for the `grafana-cloud/otlp-auth` JSON secret (matches marshal's seeder behavior).
- `secrets.template.json` updated: added `grafana-cloud/otlp-auth` (required) and `workos/api-key` (optional); removed `okta/client-credentials`.

### Docs
- `docs/workos-setup.md` — new, 10-minute walkthrough (replaces hypothetical Okta setup).
- `docs/grafana-cloud-setup.md` — new, 15-minute walkthrough to get traces/metrics/logs flowing.
- `docs/troubleshooting.md` — Okta section rewritten as WorkOS; new Telemetry section.
- `docs/secrets.md` — inventory updated for new secret map.
- `docs/deployment-guide.md`, `docs/forking-for-a-new-client.md`, `docs/runbook.md`, `docs/threat-model.md`, `docs/drills.md`, `docs/github-app-setup.md`, `README.md`, `CLAUDE.md` — Okta refs swept to WorkOS; telemetry sections added.

## [0.1.0] — 2026-04-20

Initial release. Dependency-upgrade automation: poll npm → classify breaking changes (Haiku) → scan user repos (GitHub code search) → synthesize patches (Sonnet / Opus escalation) → open GitHub App PR with changelog citations. Multi-tenant via Okta, deployed to a dedicated AWS sub-account, SOC2-adjacent audit trail.

### Architecture
- **Hexagonal split.** `src/core/` is pure domain; `src/adapters/` is infra. ESLint `no-restricted-imports` prevents `@aws-sdk/*`, `@octokit/*`, `hono`, `jose` from entering core.
- **Nominal types.** `TeamId`, `UpgradeId`, `InstallationId` are branded. Every port method that touches tenant state requires `TeamId` — cross-tenant reads are compile errors.
- **Ports + composition root.** 15 ports in `src/core/ports.ts`; production composition in `src/adapters/compose.ts`; test composition via `tests/fakes.ts`.
- **Same code in Lambda + local dev.** `src/handlers/{api,poller,upgrader}.ts` are thin Lambda entrypoints; `src/local.ts` runs the same Hono app + poller loop for development.

### Deployment
- **CDK + Lambda + API Gateway + SQS FIFO + DynamoDB + Bedrock.** 7 constructs in `infra/lib/constructs/` (storage, secrets, bedrock, api, poller, worker, observability). Split stacks: no shared resources across envs.
- **FIFO `MessageGroupId = ${teamId}:${repo}:${pkg}`.** Scoped narrowly so a noisy tenant can't serialize unrelated work. Per-team cost ceiling enforced via the DDB-backed token bucket instead.
- **No `reservedConcurrentExecutions` on the worker.** FIFO group-id fanout gives per-tuple serialization without starving other teams. ADR 0001.
- **Bedrock inference logging disabled account-wide.** CDK sets `loggingEnabled=false`; AWS Config rule alarms on drift. Requires dedicated sub-account. ADR 0003.

### Security
- **Structural tenant isolation.** `TeamId` nominal type + every DynamoDB query partition-scoped on `teamId`. Cross-tenant reads are compile-time errors, not runtime checks. Integration test asserts it.
- **Idempotent PR opens.** `sha256(teamId|repo|pkg|from|to)` is both the SQS `MessageDeduplicationId` and the PR ledger sort key; ledger `ConditionExpression: attribute_not_exists` means only the first writer wins. ADR 0004.
- **Ledger-desync handling.** If PR opens but ledger write fails, three retries with exponential backoff; on exhaustion, audit records `ledger-desync` with the PR URL and an `alert` tag for ops.
- **Changelog SSRF guard.** Fixed allowlist (`github.com`, `raw.githubusercontent.com`, `api.github.com`, `registry.npmjs.org`, `www.npmjs.com`) enforced before fetch. Adding a host is a security-review event.
- **GitHub App installation tokens only.** No PATs. Tokens cached in DynamoDB (`kiln-github-token-cache`) across Lambda cold starts with a 50-minute cap for 60-minute tokens.
- **Okta JWKS verification.** Audience + issuer pinned at adapter construction. `teamId` from a dedicated claim (`kiln_team_id`), never derived from `sub` or email prefix.
- **Module-scope-cached secrets.** Secrets Manager GetSecretValue cached for half the credential lifetime; secret value never logged, never env-injected.

### Testing
- **Trophy shape.** Static (strict TS + ESLint flat config with core-purity enforcement) > integration (DynamoDB Local via testcontainers) > unit (pure core/) > evals (gated behind `KILN_RUN_EVALS=1`).
- **Cross-tenant isolation proof.** `tests/integration/cross-tenant-isolation.test.ts` writes as team A, asserts team B sees nothing.
- **Rate-limiter concurrency proof.** 10 concurrent `tryAcquire` calls against capacity 5 ⇒ exactly 5 succeed.
- **Pipeline E2E with fakes.** `tests/integration/upgrader-pipeline.test.ts` runs the full upgrade sequence against real DynamoDB Local, fake LLM + fake GitHub.
- **Evals corpus** — React 19, Zod 4, Prisma 6, Next 15 changelogs with ground-truth breaking-change labels.

### Observability
- **Structured JSON logs to stderr.** `trace_id`/`span_id` fields reserved; correlation IDs via `.child({ teamId, upgradeId })`.
- **CloudWatch alarms.** Upgrade DLQ depth > 0; Bedrock Config-rule drift (inference logging flipped back on).
- **SNS alarm topic.** Subscribe operationally (Slack webhook, email) — not wired by CDK.

### Docs
- `docs/deployment-guide.md` — staged first-time setup
- `docs/secrets.md` — inventory + rotation cadence
- `docs/troubleshooting.md` — symptom → cause → fix
- `docs/drills.md` — synthetic pipeline exercises
- `docs/github-app-setup.md` — one-time App registration
- `docs/forking-for-a-new-client.md` — rename + swap secrets for a new tenant
- `docs/runbook.md` — on-call day-2
- `docs/threat-model.md` — STRIDE-flavored
- `docs/adr/0001..0005.md` — architecture decisions with context + alternatives

### V1 scope boundaries
- TypeScript/JavaScript repos only
- Top-level deps only (no transitive)
- Five flagship packages: `@aws-sdk/*`, `react`, `next`, `prisma`, `@types/node`
- Single-region (`us-west-2`); cross-region Bedrock inference profile for LLM failover
- No auto-merge — kiln opens PRs, humans merge
