# watchtower-infra

AWS CDK infrastructure for watchtower, composed on [`@nanohype/cdk-constructs`](https://github.com/nanohype/cdk-constructs).

## Prerequisites

- Node.js ≥ 24 (matches the worker runtime and `@nanohype/cdk-constructs` engines field)
- AWS CLI configured with appropriate credentials
- AWS CDK CLI — `npm install -g aws-cdk`

## Stack layout

`WatchtowerStaging` and `WatchtowerProduction` are both defined in `lib/watchtower-stack.ts` and instantiated from `bin/app.ts`. The `isProd` flag flips multi-AZ, backups, deletion protection, task count, and removal policies.

Resources provisioned (all via `@nanohype/cdk-constructs` except the audit Lambda):

- VPC (1 NAT staging / 2 prod)
- `BedrockLoggingDisabled` — account+region posture asserted every deploy
- `PgvectorDatabase` — Postgres 16 rule corpus; `CREATE EXTENSION vector` runs app-side on boot
- `DynamoTable` × 4 — clients config, crawler dedup, memos (envelope-encrypted, `byStatus` GSI), audit hot table
- `EnvelopeKey` — customer-managed KMS key for memo payloads
- `ArchiveBucket` — S3 audit archive (intelligent-tiering @90d, 1y expiration)
- `SqsWithDlq` × 4 — crawl → classify → publish → audit stage handoff (audit is FIFO)
- `CronSchedule` × 4 — per-source crawl cadence (SEC/CFPB/OFAC/EDPB)
- `AppSecrets` — OAuth + notification creds (seed-placeholder on CREATE, preserve-on-UPDATE)
- `WorkerService` — ECS Fargate, no ALB
- `OtelSidecar` — ADOT collector: traces → X-Ray, metrics → CloudWatch EMF
- `AuditConsumer` — Lambda (SQS → DDB + S3), bundled via `NodejsFunction` from `lambda/audit-consumer.ts`

## Getting started

First-time setup per account + region:

```bash
cdk bootstrap aws://ACCOUNT_ID/us-west-2
```

Day-to-day:

```bash
npm ci              # install deps (at infra/)
npm run synth       # cdk synth — builds both stacks into cdk.out/
npm run diff        # cdk diff against deployed stack
npm run deploy      # cdk deploy <stack>  (specify stack via CDK_DEPLOY_ENV or CLI arg)
```

Region is driven by `CDK_DEFAULT_REGION` / `AWS_REGION`, with `us-west-2` fallback (`bin/app.ts`).

## Adding or changing infrastructure

- **Infrastructure primitives**: prefer constructs from `@nanohype/cdk-constructs` over hand-rolling. If the library is missing a primitive, open an issue at github.com/nanohype/cdk-constructs and add it upstream.
- **Lambda handlers**: place new handlers under `lambda/` and wire them with `NodejsFunction` so esbuild bundles them from TypeScript source.
- **Stack-level wiring**: `lib/watchtower-stack.ts` is the composition layer. Keep construct construction grouped by concern (networking, data, queues, compute, telemetry).

## Project structure

```
bin/app.ts                       # CDK app — instantiates staging + production stacks
lib/watchtower-stack.ts          # Stack — composes @nanohype/cdk-constructs
lambda/audit-consumer.ts         # Lambda handler (bundled via NodejsFunction)
cdk.json                         # CDK CLI config — uses `npx tsx bin/app.ts`
tsconfig.json                    # TypeScript strict, ES2022 + NodeNext ESM
```

## Module system

This package is ESM (`"type": "module"` in `package.json`). `bin/app.ts` and `lib/watchtower-stack.ts` use `.js` extensions on imports. `ts-node` is not used — `cdk.json` runs `npx tsx bin/app.ts`, which handles ESM TypeScript cleanly without flags.
