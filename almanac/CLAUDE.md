# almanac

Internal Slack knowledge bot — answers employee questions over Notion, Confluence, and Google Drive with per-user ACL enforcement.

## What This Is

A protohype project in the nanohype ecosystem. Composes patterns from `slack-bot`, `rag-pipeline`, `module-vector-store`, and `infra-aws` templates into a working application. Employees @mention the bot or DM it; it answers grounded in their own access-controlled documents and cites every source.

**Built as a reusable subsystem.** Every external-IO service is a `createXxx(deps)` factory accepting typed ports (`typeof fetch`, a narrow `RedisPort`, a `RetrievalBackend`, or an AWS SDK client). `src/index.ts` is the single place real SDK clients are constructed; everything downstream runs against port interfaces, so swapping Redis → Valkey, WorkOS → Okta/Entra/Google Admin, pgvector → OpenSearch/Qdrant/Pinecone, or Bedrock → another LLM is a one-file change.

## How It Works

```
Slack event ─► rate-limit (Redis) ─► identity (Slack users.info → WorkOS Directory Sync)
                                            │
                                            ▼
                              load per-user OAuth tokens (DDB + KMS)
                                            │
                                            ▼
              embed query (Bedrock Titan) ──► hybrid k-NN+BM25 search (pgvector / swappable)
                                            │
                                            ▼
           per-user ACL verify (Notion/Confluence/Drive) — fail-secure
                                            │
                                            ▼
           generate answer (Bedrock Claude Sonnet 4.6) → Block Kit reply
                                            │
                                            ▼
                          audit event → SQS → Lambda → DDB+S3
```

Core insight: **the ACL check happens after retrieval, against the asking user's own OAuth tokens.** A document scoring high in the index is dropped if the user can't read it in the source system. There is no shared service-account view of company knowledge — every query is bounded to what that user could see anyway.

Every answer cites sources with URLs and last-modified timestamps. Documents older than `STALE_DOC_THRESHOLD_DAYS` (default 90) get a stale-warning marker.

## Architecture

Every module that touches an external boundary exposes a `createXxx(deps)` factory. Bootstrap in `src/index.ts` builds the SDK clients once and hands them in.

- **src/slack/** — `createQueryHandler(deps)` orchestrates the pipeline (rate → identity → token presence check → embed → search → ACL → generate → format → audit). `createDisconnectCommand(deps)` implements the `/almanac disconnect [source|all]` slash command (user self-service revoke; revocations flow through the OAuth port → audit pipeline). `formatter.ts` builds Block Kit responses (answers, citations, OAuth prompts, rate-limit messages, error messages with trace IDs).
- **src/identity/** — `createWorkOSResolver({fetchImpl, ddbClient, workosApiKey, workosDirectoryId, ...})` maps Slack user → workforce-directory user via WorkOS Directory Sync, cached in DDB (1h TTL). Bearer-API-key auth means no service-token refresh, no L2 cache.
- **src/oauth/** — Almanac's adoption of the `almanac-oauth` package (scaffolded into `packages/oauth/` from the nanohype `module-oauth-delegation` template). `createAlmanacOAuth({auditLogger, ...})` builds the OAuth router with Notion/Atlassian/Google providers + DDB+KMS storage + a `RevocationEmitter` that lands in the audit pipeline. `url-token.ts` signs and verifies the short-lived OAuth `/start` URLs handed to users in Slack. `http.ts` bridges node:http ↔ Web-standard Request/Response so the module's framework-neutral handlers can live on Almanac's existing HTTP server.
- **src/connectors/** — `createAclGuard({fetchImpl, onCounter})` verifies access per source (Notion/Confluence/Drive) using a `getAccessToken` callback (supplied by the query handler as `oauth.getValidToken`). Per-source probes live in `notion.ts`/`confluence.ts`/`drive.ts` behind a `ConnectorVerifier` registry; each probe receives the injected `fetchImpl` so tests pass `vi.fn<typeof fetch>()`. Every source gets its own circuit breaker (`failureThreshold: 5`, `windowMs: 60s`, `halfOpenAfterMs: 30s`); when a breaker trips we emit `circuit_open_total{source}` once and short-circuit to `wasRedacted=true` until the cooldown elapses. Fail-secure: missing token, 403, 404, timeout, network error, or open breaker → `wasRedacted=true`.
- **src/rag/** — `createRetriever({backend, bedrock, embeddingModelId, onCounter})` runs k-NN (Bedrock Titan embeddings) + BM25 against a narrow `RetrievalBackend` port (null, pgvector, or a custom adapter) and fuses via Reciprocal Rank Fusion (`rrfFusion` is a pure export, covered directly). The retrieval backend (k-NN + BM25) is wrapped in one breaker (`source: "retrieval"`); when tripped we log a warn and return empty hits — the generator handles empty context gracefully. Embeddings (Bedrock Titan) are deliberately not on the same breaker (Bedrock has its own retry). `createGenerator({bedrock, llmModelId, staleThresholdDays, ...})` calls Claude Sonnet 4.6 via Bedrock with a strict system prompt and the verified-accessible documents.
- **src/audit/** — `createAuditLogger({sqs, queueUrl, dlqUrl, ...})` builds and emits audit events to SQS (at-least-once → DLQ → `AuditTotalLoss` metric). Discriminated `AuditEvent = QueryAuditEvent | RevocationAuditEvent` union. `buildQueryAuditEvent` is a pure helper, covered directly. `pii-scrubber.ts` removes email/phone/SSN/credit-card/AWS-account/GitHub-PAT/Slack-token/JWT/API-key patterns at the boundary.
- **src/ratelimit/** — `createRateLimiter({redis, userPerHour, workspacePerHour})` is a Redis sliding-window limiter (per-user + per-workspace). Multi-instance ECS requires shared state; in-memory Maps would multiply the limit by instance count. Fails open if Redis is unreachable.
- **src/redis.ts** — Default ioredis client factory used by the bootstrap. Consumers receive the Redis port via `createXxx` factory deps, never via direct module import.
- **src/util/circuit-breaker.ts** — `createCircuitBreaker({name, failureThreshold, windowMs, halfOpenAfterMs, onOpen, now?})` is a pure, timer-less breaker used by the ACL guard (per source) and the retriever (one). Closed → sliding-window failure count; once the count reaches threshold, open and fail fast with `CircuitOpenError`. After `halfOpenAfterMs` a single probe is allowed; success → closed, failure → back to open with a fresh `openedAt`. `onOpen` fires exactly once per closed→open transition so callers can wire a `circuit_open_total{source}` counter. All time reads go through the injected `now()` — tests tick a fake clock synchronously.
- **src/metrics.ts** — OTel metrics (`@opentelemetry/api`) behind a `timing` / `counter` / `flushMetrics` surface that's call-site-compatible with the old CloudWatch emitter. `timing` → histogram (unit `ms`), `counter` → monotonic counter; both are exported OTLP by the auto-instrumentation runtime to the ADOT collector sidecar → Grafana Cloud Mimir. `flushMetrics` is a no-op retained for shutdown-path symmetry.
- **src/context.ts** — `requestContext.run(_ctx, fn)` wraps `fn` in a `slack.query` OTel active span. The `traceId` field in the legacy argument is ignored (OTel owns trace IDs); callers that still want a local UUID for user-facing error messages keep their own variable. No AsyncLocalStorage shim.
- **src/config/** — Zod schema validates every env var at startup; missing required keys fail-fast via `process.exit(1)`.
- **src/logger.ts** — Pino, JSON to stderr. The mixin pulls `trace_id` + `span_id` from the active OTel span on every log call, so any code running inside an auto-instrumented fetch/http/aws-sdk hop (or the outer `requestContext.run`) emits fields Grafana Tempo → Loki can jump between one-click.
- **src/index.ts** — Bootstrap. Builds every SDK client (Redis, SQS, DDB, Bedrock, retrieval backend, OAuth router) once, wires every `createXxx(deps)` factory, registers Bolt handlers (query + disconnect command), starts the `node:http` server on port 3001 serving `/health` + `/oauth/:provider/{start,callback}`. Graceful shutdown flushes metrics and stops Bolt on SIGTERM/SIGINT.
- **packages/oauth/** — The scaffolded `almanac-oauth` package (module-oauth-delegation). Linked via `file:./packages/oauth` in Almanac's `package.json`. Self-contained: its own `package.json`, `tsconfig.json`, `vitest.config.ts`, **176 tests across 24 files**. Rebuild with `cd packages/oauth && npm run build`.
- **infra/lib/almanac-stack.ts** — CDK: ECS Fargate, internet-facing ALB fronting `/health` + `/oauth/:provider/{start,callback}` (HTTPS when `certArn` + `domainName` env vars are set, HTTP-only otherwise), DDB ×3 (tokens keyed on `(userId, provider)` to match the module's storage), ElastiCache Redis, RDS Postgres (pgvector), SQS+DLQ, Lambda audit consumer (`NODEJS_24_X`, explicit log group, 30d retention), S3 audit archive, KMS, Secrets Manager, VPC, Bedrock invocation logging disabled via `AwsCustomResource`, CloudWatch alarms (QueryP95 > 5s, LLMError ≥ 5/5min, AuditTotalLoss ≥ 1, AuditDLQ depth). Observability sidecars: ADOT Collector (OTLP → Grafana Cloud Tempo + Mimir, config from `infra/otel/collector-ecs.yaml`) + Fluent Bit FireLens log router (stdout → Grafana Cloud Loki, image built from `infra/otel/fluent-bit/`). App container uses `ecs.LogDrivers.firelens({})`; a dedicated CloudWatch log group `ForwarderDiagnosticsLogGroup` captures the collector + forwarder's own stderr (break-glass when Grafana is unreachable). Auth lives in a BYO Secrets Manager secret `almanac/${env}/grafana-cloud/otlp-auth` (shape: `instance_id`, `api_token`, `loki_username`, `loki_host`). Stack outputs `ServiceUrl`, `AlbDnsName`, `ClusterName`, `ServiceName` so `scripts/smoke.sh` can locate the live endpoint + service deterministically.
- **scripts/smoke.sh** — Post-deploy smoke: reads stack outputs via CFN, waits for ECS steady state, curls `/health` (expects 200 with retry/backoff), then `/oauth/notion/start` (expects non-5xx — handler reachable, rejects unsigned URL cleanly). Used as the final step of `npm run deploy:{staging,production}`.

## Commands

```bash
npm run dev            # Start service via tsx watch (src/index.ts)
npm run build          # tsc -p tsconfig.build.json — emits dist/, excludes *.test.ts
npm start              # Run compiled output (dist/index.js)
npm test               # vitest run — 12 files, 81 tests
npm run test:coverage  # vitest run --coverage (v8 provider)
npm run test:watch     # interactive vitest watch mode
npm run lint           # eslint src/ — flat config + typescript-eslint v8
npm run format         # prettier --write .
npm run format:check   # prettier --check .
npm run typecheck      # tsc --noEmit
npm run check          # typecheck + lint + format:check + test (CI parity)
npm run audit:prod     # npm audit --audit-level=high --omit=dev
```

Infrastructure (`almanac/infra/`):

```bash
npm run build          # Compile CDK
npm run synth          # cdk synth
npm run deploy         # cdk deploy
```

End-to-end deploy (from `almanac/` root) — install → build oauth package → typecheck → lint → format:check → test → npm audit → `cdk deploy` (which builds Docker via the CDK asset, publishes to the bootstrap asset repo, rolls ECS) → post-deploy smoke against the live ALB:

```bash
npm run deploy:staging       # or deploy:production
npm run smoke:staging        # standalone — idempotent, safe to re-run
```

CDK uses `ecs.ContainerImage.fromAsset("..")` so each deploy produces a new image digest → the task def references the digest → ECS rolls automatically. No separate `docker push` or `aws ecs update-service --force-new-deployment` step. The stack provisions an internet-facing ALB fronting `/health` + `/oauth/:provider/{start,callback}`; `APP_BASE_URL` is wired to `domainName` when set, otherwise the ALB DNS. First-time only: `cd infra && npx cdk bootstrap` + populate `almanac/{env}/app-secrets` in Secrets Manager. HTTPS is env-driven, three shapes: `ALMANAC_<ENV>_DOMAIN` + `_HOSTED_ZONE_ID` → CDK provisions the cert + Route 53 alias automatically; `ALMANAC_<ENV>_CERT_ARN` + `_DOMAIN` → BYO cert, you own the alias; neither → HTTP-only ALB (smoke mode, OAuth providers will reject callbacks).

## Configuration

All config via env vars, validated by Zod in `src/config/index.ts`. Copy `.env.example` to `.env` and fill in. Required (no defaults):

- **Slack**: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`
- **AWS**: `DYNAMODB_TABLE_TOKENS`, `DYNAMODB_TABLE_AUDIT`, `DYNAMODB_TABLE_IDENTITY_CACHE`, `SQS_AUDIT_QUEUE_URL`, `SQS_AUDIT_DLQ_URL`, `KMS_KEY_ID`, `REDIS_URL`. Operators also provision `almanac/${env}/grafana-cloud/otlp-auth` in Secrets Manager with `{instance_id, api_token, loki_username, loki_host}`; the ADOT sidecar + Fluent Bit forwarder read it via `ecs.Secret.fromSecretsManager` — see `docs/secrets.md` for the JSON shape.
- **WorkOS**: `WORKOS_API_KEY`, `WORKOS_DIRECTORY_ID`
- **OAuth apps** (per source): `NOTION_OAUTH_*`, `CONFLUENCE_OAUTH_*`, `GOOGLE_OAUTH_*`
- **OAuth delegation**: `STATE_SIGNING_SECRET` (≥ 32 bytes — HMACs both the module's state cookie and Almanac's signed `/start` URL tokens)
- **App**: `APP_BASE_URL`

Defaults: `AWS_REGION=us-west-2`, `BEDROCK_REGION=us-west-2`, `BEDROCK_LLM_MODEL_ID=anthropic.claude-sonnet-4-6`, `BEDROCK_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0`, `RATE_LIMIT_USER_PER_HOUR=20`, `RATE_LIMIT_WORKSPACE_PER_HOUR=500`, `STALE_DOC_THRESHOLD_DAYS=90`, `TOKEN_STORE_ENCRYPTION_CONTEXT=almanac-token-store`, `NODE_ENV=development`.

App-level secrets in deployment live in AWS Secrets Manager at `almanac/{env}/app-secrets`. Per-user OAuth tokens live in DynamoDB with KMS envelope encryption — NOT in Secrets Manager (per-user secrets would cost ~$4k/month at 10k users vs ~$10/month for DDB+KMS).

**Seeding / rotating the secret:** shape, CLI, and per-key provenance in [`docs/secrets.md`](docs/secrets.md).

## Conventions

- TypeScript strict, ESM NodeNext, Node ≥ 24 (Active LTS). Docker base image `node:24-alpine`, CI runs Node 24, Lambda runs `NODEJS_24_X`.
- Zod for all input validation (config, Slack event payloads at the boundary, third-party API responses).
- Structured JSON logging to stderr via Pino (`src/logger.ts`) — stdout reserved for CLI output.
- Logs / metrics / traces correlate via OTel `trace_id`; the logger pulls from the active span automatically (no ALS). App stdout → FireLens → Grafana Cloud Loki; OTLP → ADOT collector sidecar → Grafana Cloud Tempo (traces) + Mimir (metrics).
- Vitest for tests with `globals: true`. `src/test-setup.ts` seeds env vars so the config Zod parse succeeds in the runner.
- ESLint flat config (`eslint.config.js`) + `typescript-eslint` v8, no warnings allowed in CI.
- Prettier 3.8 — `format:check` is part of CI.
- Explicit timeouts on every external call (`AbortSignal.timeout` on fetch and Bedrock, `NodeHttpHandler` `requestTimeout`/`connectionTimeout` on AWS SDK clients, ioredis `connectTimeout`/`commandTimeout`).
- **Ports, not SDK patches.** Every cross-boundary service is a `createXxx(deps)` factory accepting typed ports. Tests inject fakes implementing the typed port. **Never `vi.mock(<sdk-package>)`** — the rule is grep-enforced in CI.
- Fail-secure as the default failure mode for ACL checks: missing token, error, timeout → the document is dropped from results.
- Fail-open as the default for the rate limiter: Redis errors do not block users (the limiter's job is throttling, not authentication).

## Testing

13 test files, colocated as `src/**/*.test.ts`. Run with `npm test`. Threshold-enforced coverage: 75 / 60 / 75 / 75 (statements / branches / functions / lines). Excludes `src/index.ts` (bootstrap, only verifiable in real-Slack integration), `src/connectors/types.ts` (type-only), `src/test-setup.ts`, and `*.test.ts` files themselves.

Service-wrapper tests (boundary services, port-injected fakes):

- `src/ratelimit/redis-limiter.test.ts` — fake `RateLimiterRedisPort`; under/blocked/fail-open
- `src/identity/okta-resolver.test.ts` — fake fetch + fake Redis + DDB mock; L1/L2 cache, SCIM filter shape
- `src/connectors/acl-guard.test.ts` — fake fetch; 200 grants, 403/404 redact, missing token, network error, per-source routing, circuit-breaker trip
- `src/rag/retriever.test.ts` — fake `RetrievalBackend` + Bedrock mock; pure `rrfFusion` ranking, dedup, topK, circuit-breaker trip → empty hits
- `src/rag/generator.test.ts` — Bedrock mock; zero-hits vs everything-redacted, stale citations, dedup, Bedrock failure
- `src/audit/audit-logger.test.ts` — SQS mock; primary → DLQ → total-loss fallover, pure `buildQueryAuditEvent`
- `src/metrics.test.ts` — smoke test for the OTel no-op surface (`timing`, `counter`, `flushMetrics` must not throw without a registered provider)
- `src/util/circuit-breaker.test.ts` — pure state machine; closed/open/half-open transitions, rolling window, `onOpen` firing exactly once per trip (fake clock)

Pure-logic tests (no I/O):

- `src/audit/pii-scrubber.test.ts` — every regex class
- `src/slack/formatter.test.ts` — citations fresh/stale/redacted, footer
- `src/oauth/url-token.test.ts` — signed `/start` URL round-trip, cross-provider replay, expiry

Slash-command + integration:

- `src/slack/disconnect-command.test.ts` — ack + users.info + revoke; all source/subcommand branches
- `src/slack/query-handler.integration.test.ts` — wires the real `createXxx` factories with stubbed boundaries; 6 scenarios (happy path, rate-limit blocked, missing email, identity fail, all-tokens-missing OAuth prompt, ACL redaction)

When adding tests: accept the SDK client as a typed dep on the source-side factory and inject a fake. **Do not `vi.mock(<sdk-package>)`** — that bans is rubric-enforced. AWS SDK clients use `aws-sdk-client-mock` (client-level injection, not module-level).

## Dependencies

- **`@aws-sdk/client-bedrock-runtime`** — Bedrock Claude (LLM) + Titan (embeddings); on-account inference, no source content to third parties
- **`@aws-sdk/client-dynamodb`** — token store, identity cache, audit log
- **`@opentelemetry/api`** + **`@opentelemetry/auto-instrumentations-node`** — OTel traces/metrics (histograms + counters); the `--require` hook in the Dockerfile auto-instruments http/fetch/aws-sdk/pg before user code
- **`@aws-sdk/client-kms`** — token envelope encryption
- **`@aws-sdk/client-sqs`** — audit event queue (at-least-once + DLQ)
- **`pg`** — pgvector retrieval backend (RDS Postgres)
- **`@slack/bolt`** — Slack app framework, Socket Mode
- **`@smithy/node-http-handler`** — explicit AWS SDK timeouts
- **`almanac-oauth`** — local `file:` link to `packages/oauth/`; the OAuth-delegation module
- **`ioredis`** — sliding-window rate limiter
- **`pino`** — structured logging to stderr
- **`zod`** — env validation, runtime contracts at boundaries

The HTTP boundary uses native `fetch` (Node 24's WHATWG implementation) for Notion / Confluence / Drive ACL probes and for WorkOS Directory Sync — no axios.

## Reference docs (`docs/`)

- [`docs/prd.md`](docs/prd.md) — product requirements, OKRs, launch gates
- [`docs/rag-architecture.md`](docs/rag-architecture.md) — RAG system design
- [`docs/qa-playbook.md`](docs/qa-playbook.md) — end-to-end operator walkthrough: fresh deploy → first grounded Claude answer in Slack (+ gotcha-indexed troubleshooting appendix)
- [`docs/threat-model.md`](docs/threat-model.md) — STRIDE threat model + red-team test cases
- [`docs/compliance-checklist.md`](docs/compliance-checklist.md) — SOC 2 / GDPR controls
- [`docs/runbook.md`](docs/runbook.md) — operator runbook (incident response)
- [`docs/integrations.md`](docs/integrations.md) — every third-party integration: port, setup, env vars, verify command
- [`docs/secrets.md`](docs/secrets.md) — Secrets Manager payload shape + seed/rotate CLI
- [`docs/onboarding.md`](docs/onboarding.md) — employee onboarding playbook (end-user facing, not operator)
- [`docs/test-plan.md`](docs/test-plan.md) — full test plan
