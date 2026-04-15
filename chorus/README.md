# chorus

Cross-channel feedback intelligence — **library scaffold** (utilities, matching primitives, Postgres/pgvector schema).

> **Scope note.** This package ships the building blocks (DB pool, HTTP client, WorkOS AuthKit JWT auth, secrets cache, PII redactor, Bedrock embedder, pgvector similarity matcher, Claude Haiku title generator, SQL migrations). It does **not** ship the ingestion pipeline, push-based ingestion routes (Slack Events + webhook), Linear sync, weekly digest job, REST API, PM review UI, AWS CDK stack, or the 500-item eval harness. Those are follow-on work — see the roadmap at the bottom of this README.

## What's here

```
chorus/
├── src/
│   ├── lib/                    # shared infrastructure
│   │   ├── audit.ts            # audit-log writer (Postgres INSERT)
│   │   ├── auth.ts             # WorkOS AuthKit RS256 JWT verification + ACL helper
│   │   ├── db.ts               # pg connection pool
│   │   ├── directory.ts        # WorkOS Directory Sync user iterator
│   │   ├── http.ts             # external-API client factory with timeout + retry
│   │   ├── observability.ts    # JSON logger + correlation-id middleware
│   │   ├── queue.ts            # SQS DLQ sender
│   │   ├── secrets.ts          # Secrets Manager client with 5-min cache
│   │   └── slack.ts            # Slack postMessage + DM helpers
│   └── matching/               # matching pipeline primitives
│       ├── embedder.ts         # Bedrock Titan embeddings + RedactedText branded type
│       ├── matcher.ts          # pgvector cosine similarity + duplicate guard
│       ├── pii-redactor.ts     # regex + AWS Comprehend hybrid redaction
│       └── title-generator.ts  # Claude Haiku draft title for new entries
├── migrations/
│   └── 001_init.sql            # feedback_items, raw_evidence, backlog_entries,
│                               # audit_log, ingestion_cursors + HNSW + GIN indexes
├── scripts/
│   └── migrate.ts              # versioned migration runner
├── evals/
│   └── labeled-set-schema.md   # schema for the (not-yet-built) eval set
├── package.json
└── tsconfig.json
```

## Getting started

Requires Node 24+.

```bash
npm ci
cp .env.example .env        # fill in your values — see `Configuration`
npm run typecheck
npm run test
```

To run the schema migration against a running Postgres + pgvector:

```bash
DATABASE_URL=postgres://user:pass@host:5432/chorus npm run migrate
```

## Configuration

Every environment variable is required at the point of first use. No
placeholder defaults — the process throws on startup if anything
credential-adjacent is missing. See `.env.example` for the full list;
the highlights:

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | `db.ts`, `scripts/migrate.ts` | Postgres connection string (pgvector extension required) |
| `WORKOS_CLIENT_ID` | `auth.ts` | AuthKit client id; required for RS256 JWT verification |
| `WORKOS_ISSUER` | `auth.ts` | optional override of `https://api.workos.com` (custom auth domain) |
| `WORKOS_DIRECTORY_ID` | `directory.ts` | WorkOS Directory Sync directory id (digest job) |
| `WORKOS_PM_GROUP_ID` | `digest-job.ts` | WorkOS Directory Sync group id whose members are PMs |
| `AWS_REGION` | every AWS SDK client | defaults to `us-east-1` |
| `EMBEDDING_MODEL_ID` | `embedder.ts` | Bedrock model ID (default: `amazon.titan-embed-text-v2:0`) |
| `TITLE_GEN_MODEL_ID` | `title-generator.ts` | Bedrock model ID (default: `anthropic.claude-haiku-4-5-20251001-v1:0`) |
| `MATCH_THRESHOLD` | `matcher.ts` | cosine-similarity threshold for LINK proposals (default: `0.78`) |
| `DLQ_URL` | `queue.ts` | SQS DLQ URL (if unset, DLQ messages are logged to stderr) |
| `LINEAR_TEAM_ID` | `linear-sync.ts` | Linear team id; required to create issues on NEW-proposal approval |
| `LINEAR_MIRROR_INTERVAL_SECONDS` | `worker-entrypoint.ts` | Linear backlog mirror cadence (default 3600) |
| `SLACK_FEEDBACK_CHANNELS` | `ingest-routes.ts` | Comma-separated `channelId=squadId` mapping for Slack feedback ingestion |

Secrets (WorkOS API key, Slack bot token) are fetched from AWS
Secrets Manager by name — see `src/lib/directory.ts` and
`src/lib/slack.ts` for the exact secret IDs.

## Operations

The `Makefile` is the canonical operations entry point (matches the
sibling `mcp-gateway/Makefile` pattern). `make help` lists every
target. The most common:

| Target | What it does |
|---|---|
| `make install` | `npm ci` |
| `make ci` | typecheck → lint → format-check → test → build |
| `make test` | Vitest once |
| `make migrate` | apply pending SQL migrations (requires `DATABASE_URL`) |
| `make clean` | remove `dist/`, `node_modules/`, `coverage/` |

Underlying npm scripts (run directly when you only want one step):

| Command | What it does |
|---|---|
| `npm run build` | `tsc` — emit `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` / `npm run test:watch` | Vitest |
| `npm run migrate` | apply pending SQL migrations from `migrations/` |
| `npm run lint` | ESLint over `src/` |
| `npm run format` / `npm run format:check` | Prettier |

### API hardening

Every `/api/proposals` response ships through `helmet()` (default bundle:
CSP, HSTS, X-Frame-Options SAMEORIGIN, X-Content-Type-Options nosniff,
Referrer-Policy) and an explicit CORS allowlist. Cross-origin requests
are rejected unless the `Origin` header matches `CORS_ALLOWED_ORIGINS`
(comma-separated). The three write routes (`approve` / `reject` /
`defer`) share a per-caller token bucket keyed on the verified `sub` claim;
the default budget is 30 req/min and can be overridden via
`API_WRITE_RATE_PER_MIN`. Reads are unthrottled.

### Deploying to AWS

The CDK stack provisions VPC + RDS Postgres 16 (pgvector) + ECS Fargate
(api/worker/digest) + ALB + SQS DLQ + EventBridge Scheduler + KMS, with
**placeholder** Secrets Manager entries for every external token. No
secret values live in this repo or in any container image — the runtime
fetches each token by name from Secrets Manager via `lib/secrets.ts`,
so rotations require no redeploy.

**One-time bootstrap** (per AWS account/region):

```
make cdk-bootstrap
```

**Build, push, deploy in one command** (image tag defaults to the short
git SHA so each deploy is uniquely addressable):

```
make deploy                 # tag = $(git rev-parse --short HEAD)
make deploy VERSION=v0.1.0  # explicit tag for releases
```

`make deploy` runs `docker-build` → `ecr-push` → `cdk-deploy`. To run
the steps independently, see `make help`.

To pass WorkOS + custom domain config to the runtime tasks at deploy
time:

```
npx cdk deploy --app "npx tsx infra/bin/chorus.ts" \
  -c apiImageUri=...   -c workerImageUri=... -c digestImageUri=... \
  -c workosClientId=client_01XXXXXXXXXXXXXXXXXXXXXXXX \
  -c workosDirectoryId=directory_01XXXXXXXXXXXXXXXXXXXXXXXX \
  -c workosPmGroupId=directory_group_01XXXXXXXXXXXXXXXXXXXXXXXX \
  -c linearTeamId=team_01XXXXXXXXXXXXXXXXXXXXXXXX \
  -c slackFeedbackChannels=C0ABCDE=growth,C0XYZ12=billing \
  -c apiDomainName=chorus.acme.com
```

`workosIssuer` is also accepted if you have a custom AuthKit auth
domain; otherwise the runtime defaults to `https://api.workos.com`.

### Post-deploy: seed the placeholder secrets

The CDK stack creates five Secrets Manager entries with empty
placeholder values. Populate them out-of-band before traffic flows
(values never enter source control or container images):

| Secret name | Used by |
|---|---|
| `chorus/workos/api-key` | `lib/directory.ts` (Directory Sync REST Bearer) |
| `chorus/slack/bot-token` | `lib/slack.ts` (outbound Slack bot OAuth) |
| `chorus/slack/signing-secret` | `api/ingest-routes.ts` (Slack Events request verification) |
| `chorus/linear/api-key` | `ingestion/linear-sync.ts` (Linear GraphQL API key) |
| `chorus/ingest/api-key` | `api/ingest-routes.ts` (Bearer key for `/api/ingest` webhook) |

Set each:

```
aws secretsmanager put-secret-value \
  --secret-id chorus/workos/api-key \
  --secret-string "$WORKOS_API_KEY"
# repeat for each of the five names above
```

The `lib/secrets.ts` cache has a 5-minute TTL, so rotated values
propagate within five minutes without restarting tasks.

### Apply migrations against the deployed RDS

RDS lives in isolated subnets, so connect through a bastion or via SSM
session, then run `make migrate` with the RDS endpoint:

```
DATABASE_URL=postgres://chorusapp:$DB_PWD@$RDS_ENDPOINT:5432/chorus make migrate
```

The DB password is in the `DbCredentials` secret created by the stack
(see the `DbSecretArn` stack output).

## Architectural notes

- **Strict TypeScript** — `strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `noImplicitReturns` are all on.
- **ESM** — `"type": "module"`; imports use `.js` extensions per
  NodeNext resolution.
- **External-client contract** — every outbound call goes through
  `createExternalClient()` in `http.ts`. Timeouts are hard-capped at
  10 s; retries are capped at 3 with jittered exponential backoff on
  HTTP 429/503/504.
- **Fail-closed auth** — `auth.ts` reads its WorkOS config at first
  use and throws if `WORKOS_CLIENT_ID` is unset. There are no
  placeholder URL defaults.
- **Branded redaction type** — `RedactedText` (in `redacted-text.ts`)
  is a compile-time marker that embedding inputs have passed through
  PII redaction. There are exactly two production producers:
  `createPiiRedactor` (brands after the regex + Comprehend pass) and
  `rehydrateRedacted` (used by the repository to recover the brand on
  values read back from `feedback_items.redacted_text`). Tests use
  `asRedactedForTests`.
- **Audit log is synchronous** — `audit.ts` awaits its INSERT before
  returning. This is intentional for delivery guarantee; every
  pipeline stage pays the round-trip. The `AuditPort` seam lets a
  deploy swap in an SQS-backed queueing writer when throughput
  dominates delivery-guarantee concerns.

## Components (all shipped)

| Component | Location |
|---|---|
| Ingestion orchestrator | `src/ingestion/pipeline.ts` |
| Push-based ingest (Slack Events + webhook) | `src/api/ingest-routes.ts` |
| Linear backlog sync | `src/ingestion/linear-sync.ts` |
| Worker entrypoint (Linear mirror loop) | `src/ingestion/worker-entrypoint.ts` |
| REST API with server-side ACL filter | `src/api/{server,proposals-routes,proposals-repository}.ts` |
| Weekly Slack digest | `src/digest/weekly-digest.ts` |
| Eval harness (threshold sweep, F1) | `evals/matching-accuracy-harness.ts` |
| AWS CDK stack | `infra/lib/chorus-stack.ts` |
| PM review UI (Next.js + WorkOS AuthKit) | `frontend/` (sibling package) |

## Layout conventions

Follows the `protohype` repo conventions (see the repo-root
`CLAUDE.md`): ESM, strict TypeScript, Vitest, ESLint + Prettier,
2-space indent, structured JSON logging to stdout.
