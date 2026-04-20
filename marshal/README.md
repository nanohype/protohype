# marshal

Ceremonial incident commander assistant for mid-enterprise SaaS. Cuts median P1 alert-to-war-room-assembled from ~20 minutes to ≤5 minutes. 100% IC-approval gate on all customer-facing status messages. Postmortem draft in Linear within 2 minutes of resolution.

## What This Is

A protohype project composing nanohype templates (ts-service, infra-aws, agentic-loop, prompt-library, module-llm) into a long-running Slack-socket-mode daemon with a Lambda webhook ingress for Grafana OnCall alerts.

**Not a template** — this is a standalone service. Infrastructure as code in `infra/`, app code in `src/`, test suites in `test/`, and the authoritative artifact set in `artifacts/`.

## How It Works

```
Grafana OnCall webhook ──► API Gateway ──► Lambda (HMAC verify, idempotent DDB write)
                                                │
                                                ▼
                                     SQS FIFO (incident-events)
                                                │
                                                ▼
                     ECS Fargate processor ── Slack socket-mode
                     │   ├── WarRoomAssembler (WorkOS + Grafana OnCall + Grafana Cloud, parallel)
                     │   ├── StatuspageApprovalGate (two-phase commit, ConsistentRead:true)
                     │   ├── NudgeScheduler (EventBridge Scheduler, 15-min)
                     │   └── CommandRegistry (/marshal status|resolve|silence|checklist|help)
                     │
                     ▼
                DynamoDB (marshal-incidents + marshal-audit; PITR on, 366-day TTL)
```

**Core invariant:** `StatuspageApprovalGate.approveAndPublish()` is the ONLY code path that may call `StatuspageClient.createIncident()`. Enforced at three layers:
1. **Application** — IC must click "Approve & Publish" in Slack Block Kit (with confirmation dialog).
2. **Database** — `verifyApprovalBeforePublish()` queries `marshal-audit` with `ConsistentRead: true` before any Statuspage API call; throws `AutoPublishNotPermittedError` if the approval event is absent.
3. **CI** — `.github/workflows/marshal-ci.yml` greps for `createIncident()` outside the gate file and fails the build if any new call site appears. Plus grep-gates for: no `new WebClient` outside the adapter, no bare `fetch()` outside the HTTP client, no baked Secrets Manager references in CDK env vars, and a secret-inventory drift check across seeder / smoke / template / stack.

## Architecture

- **src/handlers/webhook-ingress.ts** — Lambda. HMAC-SHA256 verify (timing-safe), Zod payload validation, idempotency via DynamoDB conditional write, enqueue to SQS FIFO. HMAC secret cached by `VersionId` with 5-min TTL + force-refresh on verification failure (handles rotation race).
- **src/services/war-room-assembler.ts** — Assembles the incident war room: creates Slack private channel, resolves responders via WorkOS Directory Sync + Grafana OnCall escalation chain, attaches Grafana Cloud (Mimir/Loki/Tempo) context snapshot, pins checklist, schedules 15-min nudges. Per-call Slack timeouts via `withTimeoutOrDefault` so a wedged Slack call can't stall assembly.
- **src/services/statuspage-approval-gate.ts** — Two-phase commit: write `STATUSPAGE_DRAFT_APPROVED` → `verifyApprovalBeforePublish` (ConsistentRead) → Statuspage.io createIncident → write `STATUSPAGE_PUBLISHED`. 100% branch coverage enforced.
- **src/services/nudge-scheduler.ts** — Per-incident EventBridge Scheduler rules (survive ECS restarts). IC silence → DISABLED, not deleted, plus audit event.
- **src/services/sqs-consumer.ts** — Long-polling consumer for incident + nudge queues; DLQ-safe (no delete on failure).
- **src/services/command-registry.ts**, **src/services/event-registry.ts** — Typed dispatchers. Adding a slash command or SQS event type = one handler file + one registry line; no edits to `index.ts`.
- **src/commands/** — One file per `/marshal` subcommand (`status`, `resolve`, `silence`, `checklist`, `help`). `resolve.ts` drives the full 9-step resolution: load incident → fetch recent commits → Bedrock postmortem → Linear issue create → delete nudge → pulse-rating blocks → flip status + audit → public announcement → archive channel. Channel-scoped commands (`status`, `checklist`, `silence`, `resolve`) resolve channel → incident via the `slack-channel-index` GSI in `src/utils/incident-lookup.ts`; `help` works from any channel.
- **src/events/** — One file per SQS event type (`ALERT_RECEIVED`, `ALERT_RESOLVED`, `STATUS_UPDATE_NUDGE`, `SLA_CHECK`).
- **src/clients/** — Thin adapters: `workos-client` (Directory Sync REST API with 5-min cache, stale fallback, cursor pagination via `list_metadata.after`, capped at 50 pages / 5k members — concrete implementation of the IdP-neutral `DirectoryUser` port), `grafana-oncall-client`, `grafana-cloud-client` (read-only, hard-coded), `statuspage-client`, `linear-client` (@linear/sdk), `github-client` (CODEOWNERS + recent commits for deploy timeline).
- **src/ai/marshal-ai.ts** — Bedrock wrapper. `claude-sonnet-4-6` for drafts + postmortems, `claude-haiku-4-5` for message classification. Anthropic prompt caching on system prompts. PII stripping (emails, account IDs, IPs, internal hostnames) applied BEFORE Bedrock calls.
- **src/utils/http-client.ts** — 5-second hard timeout, 2-retry hard cap, exponential backoff with jitter. AbortController-backed.
- **src/utils/metrics.ts** — OTel Metrics API (`assembly_duration_ms`, `approval_gate_latency_ms`, `directory_lookup_failure_count`, `statuspage_publish_count{outcome}`, `incident_resolved_count`, `postmortem_created_count`). Exported via OTLP to the ADOT collector sidecar (ECS) or the in-handler NodeSDK started by `src/handlers/webhook-otel-init.ts` (Lambda — fetches the Grafana Cloud `basic_auth` at cold start via the AWS SDK so the credential never lives in the Lambda env). Ships to Grafana Cloud Mimir. Non-blocking.
- **src/utils/tracing.ts** — OTel tracing helpers: `withSpan` wrapper, SQS MessageAttributes ↔ W3C trace-context helpers. Auto-instrumentation wires up http/fetch/aws-sdk; manual spans in `WarRoomAssembler.assemble` give per-step timings (create_channel, resolve_responders, invite_responders, post_context, pin_checklist, schedule_nudge). Trace context propagates across the webhook Lambda → SQS → ECS processor hop.
- **src/utils/logger.ts** — Structured JSON logger (stdout/stderr). Stamps `trace_id` + `span_id` from the active OTel span when present so Grafana's Tempo → Loki jump works one-click. ECS processor logs ship to Grafana Cloud Loki via Fluent Bit; Lambda webhook logs stay on CloudWatch (low volume, doubles as OTel-init diagnostic coverage).
- **src/utils/audit.ts** — Audit log writer. All writes AWAITED. ConditionExpression `attribute_not_exists(SK)` for idempotency. Ships with `auditApprovalGateViolations()` for compliance sweeps.
- **src/utils/with-timeout.ts** — Generic `withTimeout` + `withTimeoutOrDefault` helpers. Used around non-critical Slack calls.
- **infra/lib/marshal-stack.ts** — CDK v2 stack: API Gateway, Lambda ingress (OTel NodeSDK started in-handler at cold start — credentials stay in Secrets Manager), SQS FIFO + DLQ (maxReceive=3), ECS Fargate (Marshal processor + aws-otel-collector sidecar), DynamoDB (PITR, RETAIN), Secrets Manager (operator-seeded per env — see `docs/secrets.md`), EventBridge Scheduler group, CloudWatch alarms (DLQ depth + processor stopped), explicit IAM DENY on EC2/RDS/EKS/S3-write/Lambda mutations.
- **infra/otel/collector-ecs.yaml** — ADOT collector config. `basicauth/grafana` extension, OTLP receivers on `:4317`/`:4318`, OTLP exporter to `otlp-gateway-prod-us-west-0.grafana.net`.
- **infra/otel/fluent-bit/** — Fluent Bit sidecar (Dockerfile + `fluent-bit.conf` + `parsers.conf`). Receives app stdout via Fargate's firelens forward protocol, parses the structured JSON, and ships to Grafana Cloud Loki. Its own stderr lands in a small CloudWatch meta-log group (`/marshal/forwarder-diagnostics`, 1-day retention) so forwarder failures stay debuggable without depending on Grafana.
- **infra/dashboards/marshal.json** — Grafana Cloud ops dashboard (import via Grafana UI or API). Mimir panels for app metrics, CloudWatch panels for AWS infra.
- **infra/alerts/marshal-rules.yaml** — Mimir alerting rules: SLO breach on p99 assembly > 5 min, directory-lookup spike, Statuspage publish failures.

## Run locally

```bash
npm install
cp .env.example .env   # fill in values — see "Configuration" below
npm run dev            # ts-node-dev against local Slack socket-mode
```

`npm run dev` expects live Slack socket-mode credentials (use a test workspace + bot app during development). DynamoDB + SQS URLs can point at staging resources; there is no local-only mode for the production integrations.

## Test

```bash
npm test                           # all suites (unit + integration)
npm run test:unit                  # unit — adapters, breaker, audit, approval gate, handlers
npm run test:integration           # requires dynamodb-local on :8000
npm run test:integration:docker    # spins up Docker container, runs integration, cleans up
npm run typecheck
npm run lint
npm run format:check
npm run check                      # typecheck + lint + format:check + test:unit (CI parity)
```

`audit.ts` and `statuspage-approval-gate.ts` are locked at 100% branches / lines / functions — CI fails on any regression there. See [§ Testing](#testing) for the Kent-Dodds-trophy distribution + the proof-of-enforcement experiment.

## Build

```bash
npm run build                      # tsc → dist/
```

## Deploy

Two CDK stacks — `MarshalStaging` and `MarshalProduction` — coexist in one AWS account/region. Each provisions API Gateway + Lambda ingress (OTel NodeSDK in-handler), SQS FIFO + DLQ, ECS Fargate (processor + ADOT collector sidecar in production + Fluent Bit sidecar in production), DynamoDB ×2 (PITR + 366-day TTL, three GSIs on incidents), EventBridge Scheduler group, and CloudWatch alarms. Secrets Manager entries are operator-provisioned via `npm run seed:{env}` before `cdk deploy` — CDK resolves each full ARN at deploy time via an `AwsCustomResource` DescribeSecret lookup, so secret values never transit CloudFormation. Resource names, secret paths, CFN export names, IAM policies, and the OTel `deployment.environment` attribute are all env-scoped (`marshal-staging-*` vs `marshal-production-*`, `marshal/staging/*` vs `marshal/production/*`). The staging task role cannot read production secrets and vice versa.

```bash
npm run deploy:staging        # install + check + cdk deploy MarshalStaging + smoke:staging
npm run deploy:production     # same for MarshalProduction
npm run smoke:staging         # standalone — idempotent, safe to re-run
npm run smoke:production
npm run cdk:diff:staging      # preview changes against a deployed stack
npm run cdk:diff:production
```

Requires Docker running locally, an `aws` CLI with creds, and `curl`. First-time deployers should stand staging up, run the scripted drill (`npm run drill:staging`), then Drill 2 from [`artifacts/incident-drill-playbook.md`](artifacts/incident-drill-playbook.md) **before** deploying production.

**Forking Marshal for a different client** — swap secrets, Slack workspace, Linear project, Grafana tenant without touching application code — [`docs/forking-for-a-new-client.md`](docs/forking-for-a-new-client.md).

**First-time setup:** staging-first walkthrough covering AWS prerequisites (Bedrock model access + inference-profile caveat, CDK bootstrap), per-env third-party accounts, Secrets Manager seeding (note: `linear/team-id` must be a UUID, not a team key), Grafana OnCall webhook wiring, and the promotion path to production — [`docs/deployment-guide.md`](docs/deployment-guide.md).

**Secret seeding + rotation** — env-scoped inventory (`marshal/staging/*`, `marshal/production/*`), `put-secret-value` commands, rotation cadence — [`docs/secrets.md`](docs/secrets.md).

**Post-deploy** — `scripts/smoke.sh` reads the target stack's CFN outputs, waits for ECS steady state, asserts the webhook HMAC gate is live (`401` on unsigned request), checks SQS + DLQ depths at rest, and verifies every env-scoped secret has been seeded. Run `smoke:staging` after every staging deploy and after any staging secret rotation; same for production.

**Nightly drill** — `.github/workflows/marshal-nightly-drill.yml` fires `scripts/ci-drill.sh` against staging on a schedule (and on-demand via `workflow_dispatch`). Guarded by the `MARSHAL_DRILL_ENABLED` repo variable — stays off until you've wired the OIDC role.

## Configuration

All configuration via env vars (validated by `src/utils/env.ts` at startup). In production, secret values come from AWS Secrets Manager via the ECS task definition; `.env.example` is for local dev only. See [`docs/secrets.md`](docs/secrets.md) for the full inventory + provenance.

| Variable | Source | Purpose |
|----------|--------|---------|
| `SLACK_BOT_TOKEN` | secret `marshal/slack/bot-token` | Slack bot OAuth (chat:write, channels:manage, etc.) |
| `SLACK_SIGNING_SECRET` | secret `marshal/slack/signing-secret` | Slack request signature verification |
| `SLACK_APP_TOKEN` | secret `marshal/{env}/slack/app-token` | Slack app-level socket-mode token (`xapp-…`) |
| `GRAFANA_ONCALL_TOKEN` | secret `marshal/grafana/oncall-token` | Grafana OnCall REST API (read-only) |
| `GRAFANA_CLOUD_TOKEN`, `GRAFANA_CLOUD_ORG_ID` | secrets `marshal/grafana/cloud-token`, `.../cloud-org-id` | Mimir/Loki/Tempo (read-only) |
| `STATUSPAGE_API_KEY`, `STATUSPAGE_PAGE_ID` | secrets `marshal/statuspage/api-key`, `.../page-id` | Statuspage.io |
| `LINEAR_API_KEY`, `LINEAR_PROJECT_ID`, `LINEAR_TEAM_ID` | secret `marshal/linear/*` | Linear postmortem destination |
| `WORKOS_API_KEY`, `WORKOS_TEAM_GROUP_MAP` | secret `marshal/workos/api-key`; map inlined in task def | WorkOS Directory Sync — responder resolution |
| `GITHUB_TOKEN`, `GITHUB_ORG_SLUG`, `GITHUB_REPO_NAMES` | secret `marshal/github/token`; rest in task def | Deploy-timeline enrichment for postmortems |
| `INCIDENTS_TABLE_NAME`, `AUDIT_TABLE_NAME` | **set by CDK** | DynamoDB table names — injected into the task def at deploy |
| `INCIDENT_EVENTS_QUEUE_URL`, `NUDGE_EVENTS_QUEUE_URL`, `SLA_CHECK_QUEUE_URL` | **set by CDK** | SQS URLs — injected at deploy |
| `SCHEDULER_ROLE_ARN`, `AWS_REGION` | **set by CDK** | EventBridge Scheduler — injected at deploy |
| `GRAFANA_ONCALL_HMAC_SECRET_ARN` | **set by CDK** | ARN of `marshal/grafana/oncall-webhook-hmac` — the Lambda fetches the value dynamically so rotation doesn't require redeploy |

The JSON-shaped secret `marshal/{env}/grafana-cloud/otlp-auth` carries all three Grafana Cloud telemetry credentials (OTLP collector + Lambda OTel + Loki forwarder) in one payload. Operator-provisioned like every other secret — the seeder auto-computes `basic_auth` from `instance_id` + `api_token` if you omit it from the JSON. See [`docs/secrets.md`](docs/secrets.md) § "The `marshal/{env}/grafana-cloud/otlp-auth` secret".

## Dashboards + alerts (one-time import)

After the stack is live and traces/metrics are flowing, import `infra/dashboards/marshal.json` via Grafana UI → Dashboards → New → Import, and upload `infra/alerts/marshal-rules.yaml` via the Grafana Cloud alerting UI or `mimirtool rules sync`. Automated provisioning via a CDK custom resource is future work.

## Conventions

Per root `protohype/CLAUDE.md`: TypeScript, ESM (`.js` import suffixes), Node 24, 2-space indent, strict TS (`exactOptionalPropertyTypes: true`), Zod at system boundaries, structured JSON logging to stderr/stdout, Jest for tests, ESLint + typescript-eslint.

Marshal-specific:
- **Ubiquitous language.** `WarRoomAssembler`, `StatuspageApprovalGate`, `NudgeScheduler`, `CommandRegistry` — not `DataProcessor` or `ExternalServiceAdapter`.
- **Registry over switch.** Slash commands and SQS events dispatch through `CommandRegistry` / `EventRegistry`. `src/index.ts` stays under 80 LOC.
- **No silent stubs.** Any command that doesn't drive its action to completion must say so to the user explicitly. `respond({ text: 'triggered' })` without actually triggering is a bug.
- **Metric failures never block flow.** `MetricsEmitter` swallows errors into warn logs. Operational visibility degrades; incident flow doesn't.

## Testing

Unit suite covers adapters, circuit breaker, audit writer, approval gate, command/event registries, HMAC cache, tracing propagation, Slack validation. Integration suite hits `amazon/dynamodb-local` for `ConsistentRead` semantics, idempotency, and cross-incident isolation. `npm run test:unit` runs on every PR; integration runs as a separate CI job with a DDB-local service container.

### Coverage thresholds

| File | Branches | Functions | Lines |
|------|----------|-----------|-------|
| `src/utils/audit.ts` | **100%** | **100%** | **100%** |
| `src/services/statuspage-approval-gate.ts` | **100%** | **100%** | **100%** |
| global | 55% | 75% | 75% |

Security-critical thresholds are load-bearing — they gate the approval-gate invariant. Global thresholds reflect the current test surface; expanding coverage to 80/85 is tracked as a follow-up.

### Proving enforcement is live

Thresholds that never fail are ceremonial. To prove the 100% gate actually blocks CI, flip one branch in `src/utils/audit.ts` (e.g. change `ConsistentRead: true` to `false`) and run `npm run test:unit`. Expected outcome: `Jest exit code: 1`, `AUDIT-006: uses ConsistentRead: true` fails. Restore, re-run: exit 0. This experiment is in the PR comment history and should be re-run whenever the threshold config changes.

### Adding tests

- Unit tests: mock external dependencies. Critical invariants (audit integrity, approval-gate sequencing) stay in the 100%-threshold files.
- Integration tests: use the real `AuditWriter` against dynamodb-local. The dynamodb-local container is for tests that would be meaningless against mocks — `ConsistentRead` semantics, `ConditionExpression` enforcement, GSI projections.

## Dependencies

- `@slack/bolt` + `@slack/web-api` — Slack socket mode + Web API.
- `@aws-sdk/client-*` — DynamoDB, SQS, Secrets Manager, Scheduler, Bedrock, Bedrock Runtime.
- `@opentelemetry/api` + `@opentelemetry/auto-instrumentations-node` + `@opentelemetry/sdk-node` — tracing + metrics via OTLP. Traces land in Grafana Cloud Tempo; metrics in Mimir.
- `@linear/sdk` — postmortem issue creation.
- `zod` — webhook payload validation.
- `aws-sdk-client-mock` + `aws-sdk-client-mock-jest` — AWS SDK mocks for unit tests.
- `aws-cdk-lib` — infra only.

## Artifacts + reference docs

Operator-facing:

| Document | Path |
|----------|------|
| Deployment guide (step-by-step, first-time) | [docs/deployment-guide.md](docs/deployment-guide.md) |
| Slack app setup (one-time per env) | [docs/slack-app-setup.md](docs/slack-app-setup.md) |
| Secrets inventory + seeding + rotation | [docs/secrets.md](docs/secrets.md) |
| Drills + "how do I see it work" | [docs/drills.md](docs/drills.md) |
| Troubleshooting catalogue | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Forking Marshal for a new client | [docs/forking-for-a-new-client.md](docs/forking-for-a-new-client.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| SRE Runbook (day-2, incident response) | [artifacts/runbook.md](artifacts/runbook.md) |
| Incident Drill Playbook (tabletop + live-fire) | [artifacts/incident-drill-playbook.md](artifacts/incident-drill-playbook.md) |
| Seed secrets from JSON | [scripts/seed-secrets.sh](scripts/seed-secrets.sh) |
| Post-deploy smoke | [scripts/smoke.sh](scripts/smoke.sh) |
| Synthetic webhook drill | [scripts/fire-drill.sh](scripts/fire-drill.sh) |
| Incident-state observer | [scripts/observe-incident.sh](scripts/observe-incident.sh) |
| Invite yourself to a drill channel | [scripts/join-drill-channel.sh](scripts/join-drill-channel.sh) |
| CI drill (used by the nightly workflow) | [scripts/ci-drill.sh](scripts/ci-drill.sh) |

Design / scoping:

| Document | Path |
|----------|------|
| PRD | [artifacts/prd-marshal.md](artifacts/prd-marshal.md) |
| Architecture | [artifacts/architecture.md](artifacts/architecture.md) |
| Test Plan | [artifacts/test-plan.md](artifacts/test-plan.md) |
| Security Threat Model | [artifacts/threat-model.md](artifacts/threat-model.md) |
