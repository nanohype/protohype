# cost-dash

Real-time cost dashboard for AI agent fleets. Tracks token usage, spend, and budget alerts per session, per agent role, and per workflow.

## What This Is

A protohype project in the nanohype ecosystem. Built from Next.js app router + Recharts + a lightweight data layer reading `.perf.json`.

**Not a template** — this is a standalone, runnable application.

## Architecture

```
.perf.json ──→ src/reader.ts ──→ src/aggregator.ts ──→ app/api/* ──→ React UI
                (parse + validate)   (compute)        (REST)      (auto-refresh)
```

- **src/schema.ts** — Zod schemas for session records and aggregated types
- **src/pricing.ts** — Model pricing constants + cost computation
- **src/reader.ts** — Reads and enriches `.perf.json`
- **src/aggregator.ts** — Pure aggregation functions (summary, agent costs, workflow costs, timeline buckets)
- **src/perf-logger.ts** — Drop-in logger for the coordinator to call after each agent invocation
- **app/api/** — Next.js route handlers: `/api/summary`, `/api/sessions`, `/api/trends`, `/api/budget`, `/api/seed`
- **components/** — React UI components (Header, SummaryBar, BudgetBanner, charts, SessionTable)

## Commands

```bash
npm run dev          # Start development server (localhost:3000)
npm run build        # Build for production
npm start            # Run production build
npm test             # Run tests (vitest)
npm run seed         # Generate sample .perf.json data
```

## Configuration

All config via environment variables. See `.env.example`.

Key ones:
- `PERF_FILE` — path to the perf JSON file (default: `./.perf.json`)
- `DAILY_BUDGET_USD` — daily budget alert threshold (default: `10`)
- `PER_SESSION_BUDGET_USD` — per-session budget (default: `1`)

## Deployment (Fly.io)

```bash
fly apps create cost-dash
fly volumes create cost_data --size 1 --region iad
fly secrets set DAILY_BUDGET_USD=10 PERF_FILE=/data/.perf.json
fly deploy
```

The `.perf.json` lives on the Fly volume at `/data/`. The coordinator must write to the same path (or sync via rsync/scp if running locally).

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

## Data Schema (.perf.json)

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
