# Changelog

All notable changes to Marshal are documented here. Dates use ISO 8601 (YYYY-MM-DD).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — until v1.0.0 any minor version can include breaking changes with a migration path documented in the release entry.

## [Unreleased]

## [0.1.0] — Initial release

Marshal is a ceremonial incident commander assistant. It assembles P1 war rooms from Grafana OnCall alerts, keeps an approval-gated Statuspage pipeline, and drafts postmortems in Linear.

### Added

#### Runtime

- Grafana OnCall webhook ingress (Lambda + API Gateway HTTP API) with HMAC-SHA256 signature verification, Zod payload validation, and idempotent DynamoDB write.
- ECS Fargate processor on Graviton (ARM64) running Slack Bolt in socket mode with a typed `CommandRegistry` and `EventRegistry`.
- `WarRoomAssembler` assembles a Slack private channel in ≤5 min: creates channel, resolves responders via parallel WorkOS directory + Grafana OnCall escalation lookup, attaches a Grafana Cloud context snapshot, pins an 11-step checklist, schedules a 15-min status nudge via EventBridge Scheduler.
- `/marshal` slash commands: `help`, `status` (draft/send), `silence`, `resolve`, `checklist` (stub for v0.2).
- `StatuspageApprovalGate.approveAndPublish()` — the only code path that calls `StatuspageClient.createIncident()`. Two-phase commit: write `STATUSPAGE_DRAFT_APPROVED` audit → strongly-consistent verify → publish. CI grep-gate prevents any other call site.
- `/marshal resolve` — 9-step resolution flow: load incident, fetch recent commits (GitHub), generate postmortem via Bedrock (Claude Sonnet 4.6), create Linear issue, delete nudge schedule, post pulse-rating blocks, flip incident to RESOLVED, post resolution announcement, archive channel.
- Bedrock `InvocationLoggingConfiguration=NONE` enforced at deploy via CDK custom resource — IC conversations with the AI never reach CloudWatch.

#### Observability

- OpenTelemetry traces + metrics via OTLP to Grafana Cloud Tempo + Mimir (ADOT collector sidecar, production-only).
- In-handler OTel bootstrap for the Lambda ingress — fetches `basic_auth` from Secrets Manager at cold start so the credential never lives in `Lambda.Environment`.
- Fluent Bit firelens sidecar ships processor stdout to Grafana Cloud Loki (production). Staging routes to CloudWatch Logs to keep the forwarder off the critical path during bring-up.
- Structured JSON logging with `.child({ incident_id })` correlation and W3C trace context propagated through SQS attributes.
- CloudWatch alarms on the incident-events DLQ (threshold ≥ 1 — a single failure pages).

#### Infrastructure (CDK v2)

- Two-stack pattern (`MarshalStaging`, `MarshalProduction`) sharing one codebase. Env-scoped naming (`marshal-{env}-*`) so staging and production coexist in one account.
- DynamoDB `marshal-{env}-incidents` with three GSIs: `event-type-index`, `incident-id-index`, `slack-channel-index` (resolves war-room channel → canonical incident_id for slash-command dispatch).
- DynamoDB `marshal-{env}-audit` with `published-without-approval-index` GSI for invariant auditing.
- SQS FIFO `marshal-{env}-incident-events.fifo` + DLQ with `maxReceiveCount: 3`. Non-FIFO queues for nudges + SLA checks.
- Dedicated EventBridge Scheduler group `marshal-{env}` — ECS service explicitly depends on the group so the first assembly's schedule-create call never races a not-yet-ready group.
- Production: `RemovalPolicy.RETAIN` on DDB + log groups, ECS circuit-breaker rollback enabled.
- Staging: `RemovalPolicy.DESTROY` on log groups, rollback disabled so failed deploys can be inspected without CloudFormation teardown.

#### Operator surface

- `scripts/seed-secrets.sh` — JSON-driven secret seeder with `REQUIRED_KEYS` inventory. Blocks on any `REPLACE_ME` value.
- `scripts/smoke.sh` — post-deploy sanity: CFN outputs, secret existence, ECS steady-state, DLQ depth == 0.
- `scripts/fire-drill.sh` — HMAC-signed synthetic P1 webhook; exercises the full path without a real OnCall integration.
- `scripts/observe-incident.sh` — snapshot an incident's DDB row + audit trail + queue depths.
- `scripts/join-drill-channel.sh` — invite the drill runner to the freshest `marshal-p1-*` channel via bot token.
- `scripts/ci-drill.sh` — CI-mode drill that fires, asserts audit events, archives the channel, cleans up.

#### Testing + CI

- 100% branch coverage enforced on `src/utils/audit.ts` and `src/services/statuspage-approval-gate.ts` (`jest.config.cjs` `coverageThreshold`).
- Integration tests against `amazon/dynamodb-local` for `ConsistentRead` semantics, idempotency, and cross-incident isolation.
- Unit suite covers HttpClient retry + timeout, circuit breaker state machine, HMAC cache invalidation, Slack adapter fail modes, Zod command-text validation.
- GH Actions workflow `marshal-ci.yml`: lint + format:check, build, unit + coverage, integration (dynamodb-local service container), `npm audit`, `tsc --noEmit`, 5 invariant grep-gates (Statuspage gate, Slack adapter, HTTP client, baked secrets, secret inventory drift), CDK synth, Docker build, merge-gate.
- GH Actions workflow `marshal-nightly-drill.yml`: scheduled canary drill against staging via GH OIDC. Asserts `ROOM_ASSEMBLED` + required audit events. Gated by `MARSHAL_DRILL_ENABLED` repo variable so it stays off until the OIDC role is provisioned.

#### Documentation

- `README.md`, `CLAUDE.md`, `CHANGELOG.md`.
- `docs/deployment-guide.md`, `docs/slack-app-setup.md`, `docs/secrets.md`, `docs/drills.md`, `docs/troubleshooting.md`.
- `docs/forking-for-a-new-client.md` — step-by-step guide for bringing up Marshal against a different Slack workspace / Linear project / Statuspage / Grafana tenant without touching application code.
- `artifacts/architecture.md`, `artifacts/prd-marshal.md`, `artifacts/threat-model.md`, `artifacts/runbook.md`, `artifacts/test-plan.md`, `artifacts/incident-drill-playbook.md`.

### Security

- HMAC-SHA256 verification with `crypto.timingSafeEqual` and version-aware cache invalidation on rotation race (`src/handlers/webhook-ingress.ts`).
- Zod validation at every system boundary (webhook payload + slash-command text + args).
- Secret values never transit CloudFormation — CDK imports by name via `AwsCustomResource` DescribeSecret; ECS/Lambda reference via ARN.
- Audit scrubber (`src/utils/audit.ts:scrubDetails`) redacts secret-shaped field names with two-tier matching (substring for compounds, exact for bare `key`/`auth`/`cookie`).
- IAM least privilege — task role scoped to specific resource ARNs + GSI paths; Lambda role narrower still.

[Unreleased]: https://github.com/nanohype/protohype/compare/feature/marshal-v0.1.0...HEAD
[0.1.0]: https://github.com/nanohype/protohype/releases/tag/marshal-v0.1.0
