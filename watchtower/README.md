# watchtower

Regulatory change radar — detects rule changes at public regulators (SEC EDGAR, CFPB, OFAC, EDPB, …), classifies them against per-client `products × jurisdictions × frameworks` configs, drafts impact memos, notifies the client's Slack / email, and publishes to Notion or Confluence after human approval.

Protohype subsystem; composed from nanohype templates on top of `@nanohype/cdk-constructs` v0.1.0.

## Why

Regulators publish rule changes all day. Most of those changes affect a specific subset of regulated entities. A generic "feed reader" buries compliance teams in noise. Watchtower encodes each client's regulated surface as a declarative config, then scores every detected rule change against that surface using Bedrock Claude — and only alerts when there's a real hit. Scores in the middle land in a human-review queue; classifier errors route the same way. Nothing silently drops.

**Core insight:** the novelty is the _applicability classifier_, not the diff. Rule X matters to Client A but not Client B. Watchtower makes that asymmetry the product.

## Quickstart

```bash
npm install
npm run check          # typecheck + lint + format:check + test (106 tests)
```

Full command reference and architecture tour: [`CLAUDE.md`](CLAUDE.md).

## What's in the box

| Layer    | Module            | What it does                                                                                                             |
| -------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Crawl    | `src/crawlers/`   | Generic RSS/Atom crawler with per-source circuit breakers; registry-keyed feeds for SEC EDGAR, CFPB, OFAC, EDPB          |
| Corpus   | `src/pipeline/`   | Chunk → Titan embed → pgvector upsert (delete-then-insert for revised bodies)                                            |
| Classify | `src/classifier/` | Bedrock Claude scoring with **fail-secure** (errors route to review, never drop)                                         |
| Memo     | `src/memo/`       | Bedrock Claude impact-memo drafter + DDB-backed state machine (`pending_review` → `approved` / `rejected` → `published`) |
| Publish  | `src/publish/`    | Notion & Confluence adapters **behind the approval gate** (two-phase commit, CI grep-gated)                              |
| Notify   | `src/notify/`     | Slack webhook + Resend email with per-channel failure isolation                                                          |
| Audit    | `src/audit/`      | Discriminated-union events → FIFO SQS (`MessageGroupId=clientId`, dedup=`eventId`)                                       |
| Infra    | `infra/`          | CDK stacks (staging + production) composed on `@nanohype/cdk-constructs`                                                 |

## Project layout

```
watchtower/
├── src/               the application (port-based DI; src/index.ts wires it all)
├── packages/          scaffolded nanohype modules available to fork from (observability,
│                      vector-store, database, queue, notifications, knowledge-base,
│                      pipeline, evals)
├── infra/             CDK stack on @nanohype/cdk-constructs + an esbuild-bundled
│                      Lambda for the audit consumer
├── docs/              threat model · runbook · integrations
├── eval/              applicability-classifier eval suites
├── Dockerfile         node:24-alpine, multi-stage, OTel auto-instrumentation
└── .github/ (at repo root) watchtower-ci.yml — per-PR CI with the approval-gate grep
```

## Conventions

TypeScript strict, ESM, Node ≥ 24. Zod at every boundary. Port-based DI — every external-IO service is a `createXxx(deps)` factory; `src/index.ts` is the single SDK construction site. Default AWS region `us-west-2`, env-driven. OpenTelemetry as the source of truth for telemetry, Pino-style JSON to stderr for structured logs.

See [`CLAUDE.md`](CLAUDE.md) for the full architecture and per-module breakdown.
