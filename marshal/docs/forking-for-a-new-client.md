# Forking Marshal for a new client

Marshal is a protohype subsystem skeleton. Forking for a different client means swapping **runtime configuration** (secrets, stack name, DDB table names, Slack workspace, Linear project, Grafana tenant) — not editing business logic. Every external integration goes through a constructor-injected client, and every AWS resource carries an env-scoped prefix derived from a single `namer()` helper.

Budget ~2 hours end-to-end: 30 min for third-party account setup, 30 min for local seed, 30 min for a clean deploy, 30 min for a drill.

## Before you start

Have ready:

- An AWS account + region you own (defaults to `us-west-2`; override via `CDK_DEFAULT_REGION` / `AWS_REGION` env vars).
- Admin access to a Slack workspace where you can create an app.
- Access to Grafana Cloud (OnCall + the Mimir/Loki/Tempo stack) — a free tier works for drills.
- A Linear workspace with a project to hold postmortems.
- A Statuspage.io account — any tier. Use a test page for drills; publish goes there too.
- A WorkOS account (for directory sync). The free tier handles drill-volume lookups.
- A GitHub org + token with `repo:read` scope (for the resolve-time commit fetch).

## 1. Name the fork

Marshal carries the name `marshal` through:

- Secrets Manager path prefix (`marshal/{env}/...`)
- DDB table names (`marshal-{env}-incidents`, `marshal-{env}-audit`)
- SQS queue names (`marshal-{env}-incident-events.fifo`, etc.)
- ECS cluster + service (`marshal-{env}`, `marshal-{env}-processor`)
- CFN export prefixes (`Marshal{Env}...`)
- EventBridge Scheduler group (`marshal-{env}`)
- Slack channel prefix (`marshal-p1-YYYYMMDD-*`)
- CloudWatch log groups (`/marshal/{env}/*`)

All of these come from `namer()` in `infra/lib/marshal-stack.ts`. If you want to rename — e.g. `sentinel` for your company — a global find-and-replace on `marshal` (lowercase), `Marshal` (PascalCase), and `MARSHAL` (SCREAMING for env vars, audit `actor_user_id: 'MARSHAL'`) covers it. Expect ~200 matches. Leave `marshal-p1-` in Slack channel names if you want operators to recognize the convention.

## 2. Third-party account setup

### Slack app

Follow [`docs/slack-app-setup.md`](slack-app-setup.md) verbatim. You'll end up with:

- Bot token (`xoxb-…`)
- Signing secret
- App-level token (`xapp-…`) with `connections:write`

Register `/marshal` as a slash command pointing at your workspace (no URL — socket mode handles it).

### Grafana OnCall + Cloud

Follow [`docs/secrets.md`](secrets.md) § "Grafana Cloud numeric identifiers." You'll seed:

- `grafana/oncall-token` — OnCall API token or service-account `glsa_…`
- `grafana/cloud-token` — Mimir API token
- `grafana/cloud-org-id` — the Mimir tenant ID (not the instance ID, not the Loki ID)
- `grafana/oncall-webhook-hmac` — generate with `openssl rand -base64 32`
- `grafana-cloud/otlp-auth` — JSON blob with `instance_id`, `api_token`, `loki_username`, `loki_host`

Create an OnCall outgoing-webhook integration later (after the first deploy — you'll need the API Gateway URL from the CFN outputs). Point it at `<WebhookApiUrl>/webhook/grafana-oncall` and paste the same HMAC secret you seeded above.

### Linear

Linear's API expects **UUIDs**, not team keys. Get them via:

```bash
LINEAR_KEY=$(cat marshal-secrets.staging.json | jq -r '."linear/api-key"')
curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_KEY" -H "Content-Type: application/json" \
  -d '{"query":"{ teams { nodes { id key name } } projects(first: 50) { nodes { id name } } }"}' | jq '.data'
```

Seed:

- `linear/api-key` — personal API key or service OAuth token
- `linear/team-id` — team UUID (e.g. `a1b2c3d4-…`), not the short key
- `linear/project-id` — project UUID for postmortems

### Statuspage.io

Two secrets:

- `statuspage/api-key` — from your Statuspage profile → API Info
- `statuspage/page-id` — the short alpha-numeric ID in your page URL

**Use a dedicated drill page** (or a hidden page) for non-production drills. The approval gate is the last line of defence; even with it, a mis-seeded page ID would publish to the wrong audience.

### WorkOS

- `workos/api-key` — Dashboard → API Keys → Staging key

You'll need to configure Directory Sync for whichever IdP feeds your on-call rotation (Okta, Google, OneLogin, etc.). Marshal reads directory groups via `WORKOS_TEAM_GROUP_MAP` env JSON on the processor task (set via `dependencies.ts` → env or CDK override).

### GitHub

- `github/token` — a PAT with `repo:read` on the repos you want in postmortem deploy timelines. Set `GITHUB_ORG_SLUG` and `GITHUB_REPO_NAMES` env vars on the processor task (via CDK).

## 3. Seed secrets

Copy the template, fill it in, seed.

```bash
cd marshal
cp secrets.template.json marshal-secrets.staging.json
# edit marshal-secrets.staging.json — replace every REPLACE_ME
AWS_PROFILE=<yours> npm run seed:staging
```

The seeder blocks if any `REPLACE_ME` slips through. `marshal-secrets.{env}.json` is in `.gitignore` — do not commit it.

## 4. Deploy

```bash
cd marshal
npm run install:all
npm run check              # typecheck + lint + format:check + unit tests
cd infra && npx cdk bootstrap  # first time per account/region
cd .. && npm run cdk:deploy:staging
npm run smoke:staging
```

First deploy takes ~5 min. `smoke.sh` verifies CFN outputs, secret existence, ECS steady state, and that the DLQ depth is zero.

## 5. Wire Grafana OnCall

Copy `WebhookApiUrl` from the CFN outputs (printed by `cdk deploy`). In your Grafana OnCall:

- Outgoing webhooks → Create
- URL: `<WebhookApiUrl>/webhook/grafana-oncall`
- Method: POST
- Signing secret: paste the same `grafana/oncall-webhook-hmac` value you seeded
- Trigger: Alert group firing

## 6. Fire a drill

```bash
npm run drill:staging
npm run drill:join:staging -- --user <your Slack member ID>
# in the war room: /marshal status draft → approve → /marshal resolve
npm run observe:staging   # inspect audit trail
```

If the Slack channel lands, the audit trail shows `ROOM_ASSEMBLED`, and `/marshal resolve` produces a Linear issue + archives the channel, the fork is working.

## 7. Production when you're ready

```bash
npm run seed:production
npm run cdk:deploy:production
npm run smoke:production
```

Production stack is identical in shape; only IAM scoping, log retention, and DDB `RemovalPolicy: RETAIN` differ.

## What you should NOT touch

- `src/services/statuspage-approval-gate.ts` — the security invariant. If you change it, CI fails on the grep-gate.
- `src/utils/audit.ts` — 100% branch coverage is enforced; any regression fails CI.
- The CDK custom resource `src/handlers/bedrock-logging-none.ts` — enforces Bedrock logging=NONE at deploy time.

## What you might want to change

- **Channel name format** (`src/services/war-room-assembler.ts:channelName`) — currently `marshal-p1-YYYYMMDD-<id-prefix>-<nonce>`. Change the prefix, not the nonce (the nonce prevents collisions).
- **Checklist items** (`src/services/war-room-assembler.ts:CHECKLIST_ITEMS`) — the 11 defaults cover a generic SaaS P1; your team may want org-specific items (SOC-2 incident reporting, legal notification, PR coordination).
- **Nudge cadence** (`src/services/nudge-scheduler.ts:ScheduleExpression`) — defaults to `rate(15 minutes)`. Longer for low-velocity incidents, shorter for a demanding IC culture.
- **Bedrock model IDs** (`src/ai/marshal-ai.ts:SONNET_MODEL_ID`, `HAIKU_MODEL_ID`) — use cross-region inference profile IDs like `us.anthropic.claude-sonnet-4-6` if on-demand throughput on the raw model ID isn't available in your account.

## Support contract

Marshal is a protohype skeleton. Treat the code as yours after forking — there's no upstream sync path. Pull design ideas, not code.
