# almanac

Internal Slack knowledge bot. Answers employee questions over Notion, Confluence, and Google Drive — every answer cites sources, every retrieval is filtered to what the asking user can already access.

Built as a reusable subsystem: every external dep is behind a typed port (`createXxx(deps)` factories), so swapping Redis/WorkOS/retrieval-backend/Bedrock for another client's stack is a one-file change to `src/index.ts`.

## Run locally

```bash
npm install
cp .env.example .env   # fill in values — see CLAUDE.md > Configuration
npm run dev
```

In Slack: `@almanac what's our vacation policy?`

## Test

```bash
npm test               # vitest run — 12 files, 82 tests, colocated as src/**/*.test.ts
npm run test:coverage  # same, with v8 coverage report
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src/ — flat config + typescript-eslint v8
npm run format:check   # prettier --check
npm run check          # typecheck + lint + format:check + test (one shot)
```

Test posture: testing-trophy with **no `vi.mock` of SDK packages** — every boundary service (`redis-limiter`, `workos-resolver`, `acl-guard`, `retriever`, `generator`, `audit-logger`, `query-handler`) accepts typed ports and tests pass fakes. AWS SDK clients are stubbed with `aws-sdk-client-mock`. The `query-handler.integration.test.ts` wires real factories with stubbed boundaries — no internal-module mocks.

## Build

```bash
npm run build          # tsc -p tsconfig.build.json — emits dist/, excludes *.test.ts
```

## Deploy

CDK stack in [`infra/`](infra/) provisions ECS Fargate, an internet-facing ALB, DynamoDB ×3, ElastiCache Redis, RDS Postgres (pgvector), SQS+DLQ, Lambda audit consumer, KMS, Secrets Manager, VPC.

One command runs everything — install → build `packages/oauth` → typecheck → lint → format check → tests → `npm audit` → `cdk deploy` (builds the Docker image, publishes to the CDK bootstrap asset repo, rolls the ECS service) → post-deploy smoke (waits for the service to stabilize, curls `/health` via the ALB, verifies `/oauth/:provider/start` is reachable):

```bash
npm run deploy:staging        # or deploy:production
```

Requires Docker running locally, an `aws` CLI with credentials, and a `curl` binary.

**First-time setup**

1. `cd infra && npx cdk bootstrap aws://<account>/us-west-2`
2. Seed `almanac/{env}/app-secrets` in Secrets Manager — see [`docs/secrets.md`](docs/secrets.md) for the JSON shape, CLI, and per-key provenance
3. For real OAuth (providers reject non-HTTPS callbacks), pick one HTTPS shape:

   **CDK-managed cert + Route 53 alias** (preferred — zero post-deploy clicks):

   ```bash
   export ALMANAC_STAGING_DOMAIN=almanac-staging.example.com
   export ALMANAC_STAGING_HOSTED_ZONE_ID=Z01234ABCDEF
   ```

   Requires you to own a Route 53 hosted zone for the apex. CDK provisions the ACM cert via DNS validation and creates the alias A record automatically.

   **BYO cert ARN** (escape hatch when ACM is owned by a separate team):

   ```bash
   export ALMANAC_STAGING_CERT_ARN=arn:aws:acm:us-west-2:...:certificate/...
   export ALMANAC_STAGING_DOMAIN=almanac-staging.example.com
   ```

   You own the Route 53 alias yourself.

   **Neither set:** stack deploys an HTTP-only ALB (fine for smoke, not for real OAuth).

Lower-level scripts when you want to run stages independently:

```bash
npm run install:all           # almanac + packages/oauth + infra
npm run check                 # typecheck + lint + format:check + test
npm run cdk:synth             # cdk synth only
npm run cdk:diff              # cdk diff only
npm run cdk:deploy            # cdk deploy (both stacks), no checks
npm run smoke:staging         # post-deploy smoke against the live ALB
npm run smoke:production
```

Deploys are local-only — CI ([`.github/workflows/almanac-ci.yml`](../.github/workflows/almanac-ci.yml) at the repo root) runs `install → build oauth → lint → typecheck → test → build → cdk synth` on every push to `main` and on PRs touching `almanac/**`. CI does not push to AWS.

## Architecture

10-step pipeline per query: rate-limit → identity → load tokens → embed → hybrid search → ACL verify → generate → format → audit. ACL verification happens _after_ retrieval against the user's own OAuth tokens — no shared service-account view, no cross-user data leaks.

Every external-IO module is a `createXxx(deps)` factory taking typed ports — `typeof fetch`, a narrow `RedisPort`, a `RetrievalBackend`, or an AWS SDK client. `src/index.ts` constructs the real clients once and threads them through. See [`CLAUDE.md`](CLAUDE.md) for the per-module breakdown, [`docs/integrations.md`](docs/integrations.md) for the full integration map, and [`docs/`](docs/) for design artifacts.

## Contributing

- TypeScript strict, ESM NodeNext, Node ≥ 24 (Active LTS)
- Pino structured logging to stderr; stdout reserved for CLI output
- Zod at every boundary (env, Slack event payloads, WorkOS responses, provider APIs)
- Explicit timeouts on every external call (`AbortSignal.timeout`, `NodeHttpHandler` `requestTimeout`/`connectionTimeout`, ioredis `connectTimeout`/`commandTimeout`)
- Fail-secure for ACL, fail-open for rate-limit
- Ports, not SDK patches: never `vi.mock(<sdk-package>)` in tests — accept the SDK client as a typed dep and inject a fake
- Tests colocated as `src/**/*.test.ts` next to the module they cover
- ESLint flat config + typescript-eslint v8, Prettier 3.8
- See [`CLAUDE.md`](CLAUDE.md) for full conventions
