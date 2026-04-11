# cost-dash

Real-time cost dashboard for AI agent fleets. Tracks token usage, spend, and budget alerts per session, per agent role, and per workflow.

## What This Is

A protohype project in the nanohype ecosystem. Built from Next.js app router + Recharts + a lightweight data layer backed by S3 (production) or local file (development).

**Not a template** — this is a standalone, runnable application.

## Architecture

```
S3 / .perf.json ──→ src/storage.ts ──→ src/reader.ts ──→ src/aggregator.ts ──→ app/api/* ──→ React UI
                     (S3 or file)     (parse + validate)   (compute)           (REST)      (auto-refresh)
```

- **src/storage.ts** — Storage abstraction: S3 when `PERF_BUCKET` is set, local file otherwise
- **src/schema.ts** — Zod schemas for session records and aggregated types
- **src/pricing.ts** — Model pricing constants + cost computation
- **src/reader.ts** — Reads and enriches perf data via storage layer
- **src/aggregator.ts** — Pure aggregation functions (summary, agent costs, workflow costs, timeline buckets)
- **src/perf-logger.ts** — Drop-in logger for the coordinator to call after each agent invocation
- **app/api/** — Next.js route handlers: `/api/summary`, `/api/sessions`, `/api/trends`, `/api/budget`, `/api/seed`
- **components/** — React UI components (Header, SummaryBar, BudgetBanner, charts, SessionTable)
- **infra/** — CDK stack: App Runner + S3

## Commands

```bash
npm run dev          # Start development server (localhost:3000)
npm run build        # Build for production
npm start            # Run production build
npm test             # Run tests (vitest)
npm run seed         # Generate sample perf data
```

## Configuration

All config via environment variables. See `.env.example`.

Key ones:
- `PERF_BUCKET` — S3 bucket name (production). When unset, falls back to local file.
- `PERF_KEY` — S3 object key (default: `perf.json`)
- `PERF_FILE` — local file path for dev (default: `./.perf.json`)
- `DAILY_BUDGET_USD` — daily budget alert threshold (default: `10`)
- `PER_SESSION_BUDGET_USD` — per-session budget (default: `1`)

## Deployment (AWS CDK)

```bash
cd infra
npm install
npx cdk bootstrap    # first time only
npx cdk deploy
```

This creates:
- **App Runner service** — runs the Next.js container, auto-scales, HTTPS
- **S3 bucket** — stores perf.json, encrypted, private
- **IAM roles** — App Runner instance gets read/write to the bucket

## Integrating with the Coordinator

Import `perf-logger.ts` into the coordinator and call `logSession()` after each agent response:

```typescript
import { logSession } from "./perf-logger.js";

// After getting response from an agent:
await logSession({
  sessionId: response.id,
  startedAt: callStart,
  completedAt: new Date(),
  workflow: "feature-build",
  agentRole: "eng-frontend",
  model: response.model,
  usage: response.usage,
});
```

## Data Schema (perf.json)

```json
{
  "sessions": [
    {
      "sessionId": "sess_abc123",
      "startedAt": "2025-01-15T10:30:00Z",
      "completedAt": "2025-01-15T10:31:45Z",
      "workflow": "feature-build",
      "agentRole": "eng-frontend",
      "model": "claude-sonnet-4-5",
      "inputTokens": 12400,
      "outputTokens": 3200,
      "cacheReadTokens": 8000,
      "cacheWriteTokens": 2000,
      "status": "completed"
    }
  ]
}
```

## Pricing (hardcoded, update in src/pricing.ts)

| Model | Input $/M | Output $/M |
|-------|-----------|------------|
| claude-sonnet-4-6 | $3.00 | $15.00 |
| claude-opus-4-6 | $15.00 | $75.00 |
| claude-sonnet-4-5 | $3.00 | $15.00 |
| claude-opus-4-5 | $15.00 | $75.00 |
| claude-haiku-3-5 | $0.80 | $4.00 |
