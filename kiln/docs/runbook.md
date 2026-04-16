# Kiln Runbook

## Overview

Kiln is a dependency-upgrade automation service running on AWS. It watches npm packages, reads changelogs, patches call sites, and opens GitHub PRs with migration work done.

## Service endpoints

| Path | Description |
|---|---|
| `GET /healthz` | Health check (no auth required) |
| `GET /readyz` | Readiness check (no auth required) |
| `GET /teams/:teamId` | Get team config |
| `POST /teams` | Create team config (platform team only) |
| `PUT /teams/:teamId` | Update team config |
| `GET /teams/:teamId/upgrades` | List recent upgrade records |
| `POST /teams/:teamId/upgrades` | Trigger manual upgrade |

## Observability

- **Traces**: OpenTelemetry → OTLP exporter → Grafana Tempo
- **Logs**: Structured JSON with `traceId` + `spanId` on every line → Grafana Loki
- **Metrics**: RED (rate/errors/duration) per endpoint → Grafana Mimir
- **Dashboard**: Grafana — search "Kiln" in the dashboard list

## Common failure modes

### `status: failed` upgrades
1. Check `errorMessage` on the upgrade record: `GET /teams/:teamId/upgrades/:upgradeId`
2. Common causes:
   - DynamoDB throttling → check CloudWatch DynamoDB metrics
   - GitHub rate limit exceeded → check kiln-rate-limit DynamoDB table
   - Changelog URL blocked → verify the dep's changelog is on an allowed domain
   - Bedrock timeout → check Bedrock CloudWatch metrics in `us-west-2`

### GitHub rate limit
Kiln uses a DynamoDB token bucket. If `tokens` in `kiln-rate-limit` table key `github-api` hits 0:
- Wait for the hourly refill (or reduce `GITHUB_RATE_LIMIT_PER_HOUR` env var)
- Check if concurrent instances are depleting the bucket unexpectedly

### Changelog fetch failing
- Verify the dep's changelog URL is on an allowed domain (see `config.changelog.allowedDomains`)
- Try fetching the URL manually: `curl -v <url>`
- Add the domain to the allowlist in `src/config.ts` and redeploy

### Team ACL issues
- Verify the user's Okta group membership includes `kiln-team-<teamId>`
- The Okta group must be included in the JWT's `groups` claim (Okta → API → Authorization servers → Claims)

## DynamoDB tables

| Table | Partition key | Sort key | Notes |
|---|---|---|---|
| `kiln-teams` | `teamId` | — | Team configs, per-team Slack/Linear tokens |
| `kiln-upgrades` | `teamId` | `upgradeId` | Full upgrade audit ledger |
| `kiln-changelogs` | `dep` | `version` | Changelog cache, TTL 7d |
| `kiln-rate-limit` | `key` | — | GitHub token bucket |

## Alert conditions (P1)

| Condition | Action |
|---|---|
| `status: failed` rate > 10% over 1h | Check Bedrock + GitHub API health |
| DynamoDB throttled errors > 0 | Scale DynamoDB write capacity |
| `/healthz` 5xx > 0 | Restart service pod |

## Deployment

```bash
# Build and start
npm install
npm run build
npm start

# Environment
cp .env.example .env
# Fill in required vars before starting
```

## On-call playbook

1. Check `/healthz` first — if down, restart pod
2. Check Grafana dashboard for error rate spike
3. Look at Loki logs: `{service="kiln"} | level="error"` in the last 15m
4. Check Tempo traces for the failing requests
5. Check DynamoDB tables for data inconsistency
6. If Bedrock is down: upgrades will fail but service remains up; check AWS status page
