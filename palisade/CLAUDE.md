# palisade

Prompt-injection detection gateway and honeypot. Reverse-proxies Bedrock, Anthropic, and OpenAI calls and blocks prompt-injection + jailbreak attempts before they reach the upstream.

## What This Is

A protohype subsystem composing nanohype templates (`api-gateway` primary, plus `guardrails`, `module-llm-gateway`, `module-llm-providers`, `module-semantic-cache`, `module-vector-store`, `module-database-ts`, `module-rate-limit-ts`, `module-queue-ts`, `module-observability-ts`, `ci-eval`, `fine-tune-pipeline`) and `infra-aws` into a reverse proxy for LLM endpoints with layered detection (heuristics → classifier → corpus-match), a label-approval gate, honeypot endpoints, and a canonical eval set gated in CI.

Fork me for a different client by swapping the upstream provider set, the corpus backend, the identity source, or the OTel exporter in `src/index.ts` — every external dependency is a port.

## How It Works

```
POST /v1/chat/completions ─► normalize ─► rate-limit ─► semantic cache ┐
POST /v1/messages                                                      │
POST /bedrock/invoke-model                                             ▼
                                                      ┌── detection pipeline ──┐
                                                      │   heuristics (fast)    │
                                                      │   classifier (Bedrock) │  (fail-secure at every layer)
                                                      │   corpus-match (pgvec) │
                                                      └────────────┬───────────┘
                                         BENIGN ◄────── allow ─────┤
                                                                   │ MALICIOUS
                                                                   ▼
                                         stable 400 {code:REQUEST_REJECTED,trace_id}
                                         + audit write + SQS fan-out + rate-limit escalate

POST /honeypot/* ───► normalize ───► jittered latency ───► synthetic refusal
                                                        + audit HONEYPOT_HIT + rate-limit escalate

POST /admin/labels/propose ─┐
POST /admin/labels/:id/approve ─► LabelApprovalGate (two-phase commit) ─► corpus write
POST /admin/labels/:id/reject ─┘
```

Core insight: **the known-attack corpus is the only thing in palisade that can grow unsupervised, and every write to it goes through a two-phase commit** — `LABEL_APPROVED` audit event written, then strongly-consistent read verified, then the pgvector insert happens. The invariant is grep-enforced: `CorpusWritePort` and `corpusWriter.addAttack(...)` may only appear in `src/gate/label-approval-gate.ts`.

On any detection block, the response is a stable `{ code: "REQUEST_REJECTED", trace_id }` at HTTP 400. No layer name, no model, no upstream latency leak. A second CI grep rule fails the build if any error response in `src/proxy/**` contains layer/model/upstream identifiers.

## Architecture

Every module that touches an external boundary exposes a `createXxx(deps)` factory. Bootstrap in `src/index.ts` builds the SDK clients once and hands them in.

- **src/index.ts** — the single wiring file. Config validation, adapter construction (real vs fake), detection pipeline composition, gate construction, HTTP server startup, graceful shutdown on SIGTERM/SIGINT.
- **src/config/** — Zod env validation. Fails fast on invalid config. Region is env-first (`CDK_DEFAULT_REGION` → `AWS_REGION` → `us-west-2` fallback).
- **src/otel/** — OpenTelemetry SDK bootstrap + a thin facade binding the `@opentelemetry/api` tracer and meter to narrow `TracerPort`/`MetricsPort` interfaces. Every detection layer emits its own span with the score as an attribute. ADOT sidecar is the OTLP target in prod; in dev the SDK no-ops when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset.
- **src/ports/index.ts** — the DI surface. Every boundary (LLM upstream, detection layer, corpus read/write, audit log, label queue, rate limiter, semantic cache, embedding, classifier, attack-log sink, honeypot sink, metrics, tracer) is a typed port. A client fork swaps implementations here and nowhere else.
- **src/proxy/** — Hono routes (`/v1/chat/completions`, `/v1/messages`, `/bedrock/invoke-model`, `/honeypot/*`, `/admin/labels/*`), request normalization across the three upstream shapes, identity extraction, error-response shape, and upstream forwarding. `rejectBody()` is the one call every detection block returns; the `grep-error-leak` CI rule forbids any other error string in `src/proxy/` and `src/honeypot/`.
- **src/detect/pipeline.ts** — the detection cascade. Heuristics → classifier → corpus-match with explicit outcomes (BENIGN short-circuits allow; MALICIOUS short-circuits block; UNCERTAIN cascades). Fail-secure: any thrown layer is treated as MALICIOUS.
- **src/detect/heuristics/** — fast patterns (role-reassignment regexes, delimiter injection, jailbreak personas, data-exfiltration strings, base64/hex encoded payloads over a size threshold, unicode-homoglyph probes). `patterns.ts` is the grep-auditable catalog; `index.ts` aggregates hits into a score.
- **src/detect/classifier/** — Bedrock Claude Haiku binary classifier, called only when heuristics returns UNCERTAIN. `fake.ts` is a deterministic in-process classifier for tests and `PALISADE_USE_FAKES=true`.
- **src/detect/corpus-match/** — last line of defense. Embed the prompt (Bedrock Titan v2), k-NN search the corpus (pgvector), block on cosine similarity ≥ threshold.
- **src/corpus/** — pgvector reader + writer. The writer is held ONLY by the gate.
- **src/gate/label-approval-gate.ts** — THE critical module. Two-phase commit: `LABEL_APPROVED` audit write → `ConsistentRead: true` verify → `corpusWriter.addAttack()` → `CORPUS_WRITE_COMPLETED`. 100%-branch-coverage enforced via vitest per-file thresholds. CI grep rule forbids `CorpusWritePort` / `.addAttack(` outside this file.
- **src/audit/** — DDB-backed audit log (marshal shape: idempotent `attribute_not_exists(SK)` writes, strongly-consistent `verifyApproval` query, defensive `scrubDetails` redaction) + DDB label queue with a `status-index` GSI. In-memory test doubles live alongside for the gate tests.
- **src/queue/** — SQS attack-log fan-out sink (primary + DLQ fall-through, metric on total loss) + Lambda-style S3 archive consumer. Honeypot hits travel the same pipe.
- **src/honeypot/** — fingerprint + synthetic-refusal handler. Jittered latency matches the real proxy's p50 so attackers can't side-channel. Shape-aware response bodies (OpenAI- vs Anthropic-shaped) so a naive client can't distinguish honeypot from real.
- **src/ratelimit/** — Redis sliding-window limiter (fail-open on Redis errors — palisade cannot brick legitimate users when the limiter itself is broken). Escalation writes a `key::escalated` key with TTL; any subsequent `check()` short-circuits.
- **src/cache/** — Redis-backed verdict cache + in-memory fallback. Keyed on `promptHash`; BENIGN and MALICIOUS verdicts both cache (MALICIOUS short-circuits before detection).
- **src/metrics.ts** — canonical metric names. Every emission site imports from here so audits + dashboard wiring are grep-able.
- **src/types/** — bounded-context types (`prompt`, `verdict`, `audit`, `corpus`, `label`, `identity`, `errors`) re-exported through `types/index.ts`.
- **eval/** — canonical attack + benign suites (YAML). `attacks.yaml` has ~40 labeled attack prompts across six taxonomies; `benign.yaml` has ~80 benign prompts chosen to share lexical surface with attacks (meta-questions about prompt-injection, role-play prompts, base64 discussions) so FPR is honest. `baseline.json` holds the numbers the eval gate compares against.
- **scripts/eval/** — `run.ts` executes the full pipeline over both suites and writes `eval/results.json`. `compare.ts` diffs against baseline and exits non-zero on TPR drop > 5% or FPR rise > 2%. `update-baseline.ts` promotes current results to baseline.
- **scripts/ci/** — grep-gates. `grep-gate.sh` enforces the label-approval invariant. `grep-error-leak.sh` forbids layer/model/upstream identifiers in the proxy error path. `grep-vi-mock.sh` forbids `vi.mock(<sdk-package>)`.
- **packages/** — nanohype modules scaffolded as reference implementations. Palisade's runtime does not depend on them directly — the app re-implements the needed surface against narrow ports so we can keep the runtime tight and avoid cross-package type drift. A client fork may replace the in-tree adapter with the module package, wiring it in `src/index.ts`.
- **infra/lib/palisade-stack.ts** — CDK v2 stack built on [`@nanohype/cdk-constructs`](https://github.com/nanohype/cdk-constructs) v0.1.0. The library supplies `PgvectorDatabase`, `DynamoTable` (with `globalSecondaryIndexes`), `RedisCluster`, `SqsWithDlq` (DLQ-depth alarm included), `ArchiveBucket`, `EnvelopeKey`, `AppSecrets` (seed-on-create, preserve-on-update), `BedrockLoggingDisabled`, `OtelSidecar`, `AlbWithTls` (managed-cert / byo-cert / http-only), `containerFromAsset` (x86_64-pinned), and `grantEcsExec`. Hand-rolled locally: the ECS `FargateService` itself (needs ALB routing, not the library's ALB-less `WorkerService`), the Lambda SQS→S3 attack-log consumer (not yet in the library), the palisade-namespace CloudWatch alarms (detection-rate spike, gate-verification-failed, upstream p95), and the task-role IAM policies (palisade-specific resource ARNs). Tag pinned at `#v0.1.0`; bump the pin when the library's foundation phase ends.
- **infra/bin/app.ts** — two-stack pattern (`PalisadeStaging` / `PalisadeProduction`), env-driven region + HTTPS shape. No source change required to switch targets.
- **Dockerfile** — multi-stage `node:24-alpine`. Build stage compiles TypeScript; runtime stage includes only prod deps + `dist/`. Non-root `USER node`.

## Commands

```bash
npm install
npm run dev                 # tsx --watch src/index.ts
npm run build               # tsc -p tsconfig.build.json
npm start                   # node dist/index.js
npm run typecheck
npm run lint
npm run format / :check
npm test
npm run test:coverage
npm run check               # typecheck + lint + format:check + test
npm run ci:all              # grep-gates + check — CI parity

npm run eval:run            # run canonical eval set
npm run eval:baseline       # promote current results to baseline
npx tsx scripts/eval/compare.ts   # regression gate (exits non-zero on drift)

cd infra && npm install
cd infra && npm run synth
cd infra && npm run deploy        # default stack selection via CDK context
```

## Configuration

All config via env vars, validated by Zod in `src/config/index.ts`. Copy `.env.example` and fill in. Notable defaults:

- `AWS_REGION=us-west-2` (env-first: `CDK_DEFAULT_REGION` overrides)
- `BEDROCK_CLASSIFIER_MODEL_ID=anthropic.claude-haiku-4-5-20251001`
- `BEDROCK_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0`
- `CORPUS_MATCH_THRESHOLD=0.88`, `CORPUS_MATCH_TOP_K=5`
- `CLASSIFIER_BLOCK_THRESHOLD=0.85`, `CLASSIFIER_ALLOW_THRESHOLD=0.25`
- `HEURISTICS_TIMEOUT_MS=50`, `CLASSIFIER_TIMEOUT_MS=2500`, `CORPUS_MATCH_TIMEOUT_MS=1500`
- `RATE_LIMIT_USER_PER_MIN=60`, `RATE_LIMIT_ESCALATION_SECONDS=900`
- `PALISADE_USE_FAKES=false` (set `true` for local dev without AWS connectivity)

Secrets live in `palisade/{env}/app-secrets` in Secrets Manager; RDS credentials live in `palisade/{env}/db-credentials`. First deploy seeds placeholders — operators replace via `aws secretsmanager put-secret-value` and `aws ecs update-service --force-new-deployment`.

## Conventions

Project conventions (Node 24, ESM `.js` suffixes, strict TS with `exactOptionalPropertyTypes`, Zod at boundaries, structured JSON logging) come from root `protohype/CLAUDE.md`.

Palisade-specific:

- **The label-approval gate is load-bearing.** Treat `src/gate/label-approval-gate.ts` like a cryptographic routine — changes need a reviewer signature and the CI grep gate must stay green. If you need a new call site of `corpusWriter.addAttack(...)`, the answer is almost always "route it through the gate," not "add an exception to `grep-gate.sh`."
- **Fail-secure on detection errors.** Any layer that throws is treated as MALICIOUS. Do not catch errors inside a layer to turn them into BENIGN or UNCERTAIN — that's a bypass.
- **Fail-open on rate-limiter errors.** Redis hiccups must not brick real users. Almanac's pattern.
- **No attacker-observable signal in error responses.** The single `rejectBody(traceId)` shape is the only reject envelope. Additions to `src/proxy/` that mention heuristics / classifier / corpus / bedrock / anthropic / openai / claude / gpt in an error path will fail CI.
- **Port-based DI for subsystem reuse.** Every external service goes through a constructor-injected port. Forking palisade for a new client means swapping the port implementation, not touching detection logic.
- **Vitest tests inject typed fakes.** `vi.mock(<sdk-package>)` is CI-banned. AWS clients use `aws-sdk-client-mock`; Redis, pg, and OTel each have a port-level fake.
- **Naming convention split (deliberate).** HTTP response bodies follow three rules:
  - **Error envelopes** use `snake_case` — `{ code: "REQUEST_REJECTED", trace_id }`. Matches common REST / OpenAPI conventions; the single `rejectBody()` helper is the only producer.
  - **Success bodies and internal field names** use `camelCase` — `draftId`, `corpusId`, `attemptId`, `promptHash`.
  - **Audit event types** use `SHOUT_CASE` — `DETECTION_BLOCKED`, `LABEL_APPROVED`, `CORPUS_WRITE_COMPLETED`. Immutable enum-shaped values.
    Consumers of the HTTP API must code for both casings. The split isn't accidental — it separates "event types / error codes / constants" from "field identifiers", and makes the grep-gate rules above easier to write correctly.

## Testing

| Tier                 | Files                                                        | What they exercise                                                 |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Static               | `tsconfig.json` strict + `eslint.config.mjs` + `.prettierrc` | Types, lint, format                                                |
| Unit                 | `src/**/*.test.ts`                                           | Gate, audit log, rate limiter, heuristics, normalization           |
| CI grep gates        | `scripts/ci/*.sh`                                            | Label-approval invariant, error-leak shape, vi.mock ban            |
| Eval (CI)            | `scripts/eval/run.ts` + `scripts/eval/compare.ts`            | End-to-end detection rate against canonical attack + benign suites |
| Integration (future) | dynamodb-local                                               | ConsistentRead semantics, idempotency of audit writes              |

### Coverage

- 100% branches + lines on `src/gate/**/*.ts` and `src/audit/audit-log.ts` — CI fails on regression.
- Global thresholds: 60% branches / 70% lines / statements / functions.

### Adding tests

- Security-critical changes go in the 100%-threshold files. Every new branch needs both sides covered.
- Detection-layer changes get a unit test plus a new labeled prompt in `eval/attacks.yaml` or `eval/benign.yaml`.
- Anything that depends on DDB semantics (ConsistentRead, conditions, GSI) deserves an integration test once the dynamodb-local harness is wired.

## Dependencies

| Package                                             | Why                                                 |
| --------------------------------------------------- | --------------------------------------------------- |
| `hono` + `@hono/node-server`                        | Reverse-proxy HTTP routing                          |
| `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` | Audit log + label queue                             |
| `@aws-sdk/client-sqs`, `@aws-sdk/client-s3`         | Attack-log fan-out + archive                        |
| `@aws-sdk/client-bedrock-runtime`                   | Claude Haiku classifier + Titan embeddings          |
| `@aws-sdk/client-cloudwatch`                        | Custom app metrics                                  |
| `pg`                                                | pgvector corpus backend                             |
| `ioredis`                                           | Rate-limit + verdict cache                          |
| `zod`                                               | Env + request-boundary validation                   |
| `pino`                                              | Structured stderr logging                           |
| `@opentelemetry/sdk-node`, exporters                | OTel traces + metrics (ADOT sidecar target in prod) |
| `aws-sdk-client-mock`                               | AWS SDK client-level fakes in tests                 |
| `aws-cdk-lib`                                       | Infrastructure-as-code (infra/)                     |

No heavy AI frameworks — Bedrock SDK calls are direct.

## Reference docs (`docs/`)

- [`docs/prd.md`](docs/prd.md) — what palisade does, why, and what "done" looks like
- [`docs/threat-model.md`](docs/threat-model.md) — STRIDE-ish threat model specific to prompt-injection gateway
- [`docs/detection-taxonomy.md`](docs/detection-taxonomy.md) — attack categories + example payloads
- [`docs/honeypot-design.md`](docs/honeypot-design.md) — decoy endpoint design + fingerprinting approach
- [`docs/runbook.md`](docs/runbook.md) — operator runbook, including pgvector schema bootstrap + first-deploy steps
