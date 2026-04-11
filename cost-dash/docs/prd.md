# PRD: Cost Dashboard

**Product:** cost-dash  
**Author:** Product Agent  
**Status:** Approved for build  

---

## Problem

Running managed AI agents across workflows (launch-prep, feature-build, etc.) generates real Anthropic API costs — Sonnet at $3/$15 per M tokens, Opus at $15/$75 per M tokens — with zero real-time visibility. The operator discovers spend only after the fact via monthly billing.

## Goal

A single-page, auto-refreshing cost dashboard that shows live and historical spend across an AI agent fleet. Glanceable in 10 seconds. No enterprise complexity.

---

## Data Sources

### 1. `.perf.json` (local file)
Written by the coordinator on every agent invocation. Schema:

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

### 2. Anthropic Usage API (real-time supplement)
- `GET /v1/organizations/{org_id}/usage` — hourly/daily token usage breakdown
- `GET /v1/organizations/{org_id}/costs` — cost data by model and time bucket
- Requires `ANTHROPIC_ADMIN_KEY` (different from standard API key)

**Priority:** `.perf.json` is the primary source (richer metadata: role, workflow). Anthropic API supplements with real-time totals and cross-check.

---

## Requirements

### Dashboard Views (single page, tabbed or scrollable sections)

#### Section 1: Live Summary Bar
- Total cost today (running)
- Total tokens today (input + output)
- Most expensive agent this session
- Budget burn rate: "at this rate, $X/day"

#### Section 2: Cost by Agent Role (bar chart)
- X-axis: agent role (product, eng-frontend, eng-ai, etc.)
- Y-axis: cost in USD
- Time filter: last session / today / this week / all time
- Click to drill into sessions for that role

#### Section 3: Cost by Workflow (donut chart)
- Slices: feature-build, launch-prep, sprint-plan, etc.
- Tooltip shows: total cost, session count, avg cost per session

#### Section 4: Token Usage Timeline (line chart)
- Daily stacked bars: input tokens vs output tokens vs cache tokens
- Two lines: Sonnet cost vs Opus cost
- Range picker: 7 days / 30 days

#### Section 5: Session Log (table)
- Columns: Time, Workflow, Agent, Model, Tokens In, Tokens Out, Cost, Duration
- Sortable, searchable
- Last 50 sessions default, paginated

#### Section 6: Budget Alerts
- Configure daily budget threshold (default: $10/day)
- Configure per-session budget (default: $1/session)
- Visual: green/amber/red burn indicator
- Alert fires when: 80% of daily budget consumed (amber), 100% (red banner)

---

## Pricing Constants (hardcoded, updatable via env)

| Model | Input $/M | Output $/M | Cache Read $/M | Cache Write $/M |
|-------|-----------|------------|----------------|-----------------|
| claude-sonnet-4-6 | $3.00 | $15.00 | $0.30 | $3.75 |
| claude-opus-4-6 | $15.00 | $75.00 | $1.50 | $18.75 |
| claude-sonnet-4-5 | $3.00 | $15.00 | $0.30 | $3.75 |
| claude-opus-4-5 | $15.00 | $75.00 | $1.50 | $18.75 |
| claude-haiku-3-5 | $0.80 | $4.00 | $0.08 | $1.00 |

---

## Non-Requirements (explicitly out of scope)
- Multi-user auth — single operator, no login
- Real-time WebSocket streaming — polling every 30s is fine
- Custom date ranges beyond last 30 days
- Export / CSV download
- Mobile-optimized layout (desktop glance is enough)

---

## Success Criteria
1. Dashboard loads in < 2s on App Runner
2. Auto-refreshes every 30 seconds without page reload
3. Shows correct cost within +/-1% of Anthropic billing page
4. Budget alert fires within one refresh cycle of threshold breach
5. Works with zero sessions (empty state shows $0.00 and instructions)
6. Single `cdk deploy` ships it

---

## Architecture Decision

- **Backend:** Node.js/TypeScript service — reads `.perf.json`, calls Anthropic Usage API, aggregates, exposes REST endpoints
- **Frontend:** Next.js single-page app with Recharts for charts
- **Deployment:** AWS App Runner + S3 via CDK
- **Refresh:** Client polls `/api/summary`, `/api/sessions`, `/api/trends` every 30s

---

## Open Questions (deferred)
- Q: Should `.perf.json` be written by the coordinator today, or does cost-dash write a stub?  
  Decision: cost-dash creates the schema + a seeder for sample data; coordinator adopts the schema going forward.
- Q: Anthropic admin key — does the operator have one?  
  Decision: Anthropic API is optional (graceful fallback to local file only). Dashboard works without it.
