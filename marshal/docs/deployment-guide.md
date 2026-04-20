# Deployment guide

End-to-end walkthrough for bringing Marshal up in a fresh AWS account. Marshal is deployed as **two independent CDK stacks** — `MarshalStaging` and `MarshalProduction` — that can coexist in the same account and region. Stand staging up first, run the drills, then repeat for production.

If you're rotating credentials on an already-running stack, jump to [`docs/secrets.md`](secrets.md) instead.

## 0. Prerequisites

### AWS side

- An AWS account you can deploy to. Export `CDK_DEFAULT_ACCOUNT` + `CDK_DEFAULT_REGION` (default region is `us-west-2` — matches the `DEFAULT_REGION` in `infra/bin/marshal.ts`):
  ```bash
  export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  export CDK_DEFAULT_REGION=us-west-2
  export AWS_REGION=us-west-2
  ```
- **Bedrock model access** must be enabled in the deployment region for:
  - `anthropic.claude-sonnet-4-6` — status drafts + postmortems
  - `anthropic.claude-haiku-4-5-20251001-v1:0` — message classification
  - `anthropic.claude-opus-4-6-v1` — (optional, future use)

  Enable via AWS console → Bedrock → Model access → Request access. Deployment fails at runtime with `AccessDeniedException` otherwise.

  **On-demand throughput caveat.** Claude 4.x-family models require **cross-region inference profiles** for on-demand invocation. Direct foundation-model invocation only works with provisioned-throughput commitments. If you invoke `anthropic.claude-sonnet-4-6` directly you'll get `"Invocation of model ID ... with on-demand throughput isn't supported"` at resolve time. Marshal uses on-demand throughput by default — see `src/ai/marshal-ai.ts` and `docs/troubleshooting.md` § "Bedrock errors" for the profile-ID switch (`us.anthropic.claude-sonnet-4-6` etc.) if you hit this.
- **Region allow-list.** `infra/bin/marshal.ts` hard-rejects regions outside `us-east-1`, `us-west-2`, `eu-west-1`, `ap-northeast-1`. These are the regions where the above Bedrock models are currently available.
- **CDK bootstrap** in the target region (one-time per account/region — covers both stacks):
  ```bash
  npx cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION
  ```

### Third-party accounts (staging + production)

Provision these **separately** for each environment — staging and production each want their own Slack workspace / Linear project / Statuspage page / Grafana Cloud stack. Credentials land in env-scoped Secrets Manager paths (`marshal/staging/*` vs `marshal/production/*`); sharing them defeats the isolation.

| System | What you need | Where to get it |
|---|---|---|
| **Slack app** | Bot token (`xoxb-…`), signing secret, app-level token (`xapp-…`) with `connections:write` (socket mode) | [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From manifest. Required scopes: `chat:write`, `channels:manage`, `channels:read`, `groups:read`, `groups:write`, `users:read`, `commands`. |
| **Grafana OnCall** | API token (read-only) + webhook HMAC secret | Grafana → OnCall → Settings → API tokens. HMAC secret is generated locally (`openssl rand -base64 32`) and pasted into the OnCall *outgoing webhook* signing field. |
| **Grafana Cloud** | OTLP instance ID, API token (`glc_…` with `otlp:write`), org ID, Loki username, Loki host | Grafana Cloud → Connections → OpenTelemetry (for OTLP) + Connections → Logs (Loki). See [`docs/secrets.md`](secrets.md) § "The `marshal/{env}/grafana-cloud/otlp-auth` secret" for the JSON shape. |
| **Statuspage.io** | API key + page ID | Statuspage → Manage → API. Page ID is visible in the Statuspage URL (`manage.statuspage.io/pages/<PAGE_ID>/`). |
| **Linear** | Personal API key + team UUID + project UUID | Linear → Settings → API → Personal API keys. **`linear/team-id` must be the team UUID, not the team key**. Get both UUIDs via GraphQL: `{ teams { nodes { id key name } } projects { nodes { id name } } }` against `https://api.linear.app/graphql`. A team key (`ENG`) in `team-id` produces `Argument Validation Error - teamId must be a UUID` at resolve time. |
| **WorkOS** | Directory Sync API key (`sk_live_…`) | [dashboard.workos.com](https://dashboard.workos.com) → API Keys. Also prepare the team-to-group map — see step 4. |
| **GitHub** | PAT or App token | GitHub → Settings → Developer settings → Personal access tokens. Scope: `repo:read` over the repos listed in `GITHUB_REPO_NAMES`. Read-only; used to fetch CODEOWNERS + recent commits for postmortems. |

### Slack app (required before first deploy)

Full walkthrough in [`docs/slack-app-setup.md`](slack-app-setup.md). Summary: you need a Slack app per environment with Socket Mode enabled, Interactivity toggled on, the `/marshal` slash command registered, the ten bot token scopes listed in that doc, and all three tokens (bot / app-level / signing-secret) seeded. Without this, the processor crash-loops at Bolt startup.

### Local tooling

- Node 24 (Active LTS)
- `aws` CLI ≥ 2.15 with creds for the target account
- Docker (the CDK asset pipeline builds the processor image locally)
- `jq` (not strictly required but recommended for inspecting CFN outputs)

## Deploy staging first

The rest of this walkthrough deploys `MarshalStaging`. Once staging is live + Drill 2 has passed, re-run the same steps with `production` to bring that stack up.

### 1. Seed every secret before the first `cdk deploy`

Every secret is operator-provisioned — CDK references them by name but does not create them. ECS refuses to start the processor task until every `ecs.Secret.fromSecretsManager(...)` reference resolves, so the seed step must run *before* `cdk deploy`, not after. Otherwise the task fails to start, the ECS deployment circuit breaker trips, and CloudFormation rolls the stack back.

The seeder (`npm run seed:{env}`) handles both first-seed (create) and rotation (put) transparently:

```bash
cp secrets.template.json marshal-secrets.staging.json
# Edit the file — replace every REPLACE_ME with the real value.
# `marshal-secrets.*.json` is gitignored.

npm run seed:staging:dry     # validates shape, no AWS calls
npm run seed:staging         # creates every required secret in Secrets Manager
```

The `grafana-cloud/otlp-auth` secret is a nested JSON object carrying Grafana Cloud credentials for all three telemetry surfaces (OTLP collector, Lambda OTel, Loki forwarder). You can omit `basic_auth` from the JSON — the seeder derives it from `instance_id` + `api_token` automatically. Per-key provenance + rotation guidance in [`docs/secrets.md`](secrets.md).

### 2. Install + build + synth

From the repo root:

```bash
cd marshal
npm run install:all           # marshal + infra workspaces
npm run check                 # typecheck + lint + tests — parity with CI
npm run cdk:synth             # CloudFormation preview
```

Synth does not require Secrets Manager to be populated; it only emits ARN references. The secrets are read at `cdk deploy` (task def validation) and at task start (ECS pulls values).

### 3. Deploy staging

```bash
npm run cdk:deploy:staging    # cdk deploy MarshalStaging
```

First deploy takes 8–12 minutes: Docker image build for the processor (including the Fluent Bit sidecar image), ECR push, ECS service create, Lambda + API Gateway provisioning, DynamoDB tables, EventBridge Scheduler role, CloudWatch alarms. CDK does not create Secrets Manager resources — it only references them by name (see step 1).

On success you'll see CloudFormation outputs:

```
MarshalStaging.WebhookApiUrl           = https://<api-id>.execute-api.us-west-2.amazonaws.com
MarshalStaging.ClusterName             = marshal-staging
MarshalStaging.ProcessorServiceName    = marshal-staging-processor
MarshalStaging.IncidentsTableName      = marshal-staging-incidents
MarshalStaging.AuditTableName          = marshal-staging-audit
MarshalStaging.IncidentEventsQueueUrl  = https://sqs.us-west-2.amazonaws.com/.../marshal-staging-incident-events.fifo
MarshalStaging.IncidentEventsDlqUrl    = https://sqs.us-west-2.amazonaws.com/.../marshal-staging-incident-events-dlq.fifo
MarshalStaging.Environment             = staging
```

Record the `WebhookApiUrl` — you'll wire it into staging Grafana OnCall in step 6.

### 4. WorkOS team → group map

The war-room assembler resolves responders via `WORKOS_TEAM_GROUP_MAP` — a JSON map from Grafana OnCall `team_id` → WorkOS `directory_group_id`. It's wired as a plain env var in the processor task def (not a secret, because the value isn't sensitive — just an identifier lookup). Edit `infra/lib/marshal-stack.ts` to add it to the processor container's `environment:` block:

```typescript
WORKOS_TEAM_GROUP_MAP: JSON.stringify({
  'team-platform': 'directory_group_01...',
  'team-data':     'directory_group_01...',
}),
```

Re-run `npm run cdk:deploy:staging` to push the updated task def.

Also set the **WorkOS team-to-group map** for staging — this tells the war-room assembler which WorkOS directory group to resolve responders from for each Grafana OnCall team. Edit `infra/lib/marshal-stack.ts` to add the env var to the processor container:

```typescript
// In the processor container's `environment:` block
WORKOS_TEAM_GROUP_MAP: JSON.stringify({
  'team-platform': 'directory_group_01...',
  'team-data':     'directory_group_01...',
}),
```

Re-run `npm run cdk:deploy:staging` after this change, or use the ECS-level update:

```bash
aws ecs update-service \
  --region us-west-2 \
  --cluster marshal-staging \
  --service marshal-staging-processor \
  --force-new-deployment
```

### 5. One-shot deploy-and-smoke

For subsequent deploys (or if you prefer a single command for the first one), use:

```bash
npm run deploy:staging        # install:all + check + cdk:deploy:staging + smoke:staging
```

This runs the full CI-parity check, deploys `MarshalStaging`, and runs the smoke against the fresh stack.

### 6. Wire the staging Grafana OnCall webhook

In **staging** Grafana OnCall → Outgoing webhook:

- **URL:** `<WebhookApiUrl>/webhook/grafana-oncall` (from the `MarshalStaging.WebhookApiUrl` output)
- **HTTP method:** `POST`
- **Signing secret:** the same value you seeded into `marshal/staging/grafana/oncall-webhook-hmac`
- **Trigger:** `Alert group firing`

The Lambda ingress verifies HMAC-SHA256 in timing-safe fashion and rejects unsigned requests with `401`. The `smoke:staging` script asserts this.

### 7. Run the smoke

```bash
npm run smoke:staging         # standalone — idempotent, safe to re-run
```

Expected:
- ECS processor stabilizes
- `POST /webhook/grafana-oncall` with unsigned body → `401` (HMAC gate is live)
- Incident queue + DLQ depth = 0
- All 14 staging secrets are seeded (`LastChangedDate` present)

If the secrets check flags any as unseeded, go back to step 4. If the 401 check returns 5xx, the Lambda itself is crashing — check `/aws/lambda/MarshalStaging-IngressFunction*` in CloudWatch Logs.

### 8. Import dashboards + alerts (one-time per env)

- Import `infra/dashboards/marshal.json` via Grafana UI → Dashboards → New → Import (staging Grafana Cloud stack).
- Upload `infra/alerts/marshal-rules.yaml` via the Grafana Cloud alerting UI or `mimirtool rules sync --address https://grafana.com/...`.

Automated provisioning via a CDK custom resource is tracked as future work. Repeat in production's Grafana Cloud stack when you promote.

### 9. Drill

Two complementary paths:

**Scripted drill (fastest — exercises the full path without a real OnCall integration):**

```bash
npm run drill:staging                                 # fires an HMAC-signed synthetic P1
npm run drill:join:staging -- --user U0123ABCD        # invite yourself to the war room
# in the war-room channel:
#   /marshal status draft    (Bedrock draft)
#   (click Approve & Publish — exercises the two-phase approval gate)
#   /marshal resolve         (Bedrock postmortem → Linear issue → channel archive)
npm run observe:staging                               # inspect the resulting audit trail
```

Full strategy menu + gotchas in [`docs/drills.md`](drills.md).

**Tabletop + live-fire (formal pre-prod checklist):**

Walk through [`artifacts/incident-drill-playbook.md`](../artifacts/incident-drill-playbook.md):

- **Drill 1 (tabletop)** — walk through a simulated P1 without firing Marshal.
- **Drill 2 (live-fire)** — send a synthetic alert through staging Grafana OnCall (real webhook, real signing, real routing); confirm assembly ≤5 min, approval gate rejects attempted unsigned publishes, Linear postmortem draft + channel archive appear after `/marshal resolve`.

**Do not hand a real alert integration to Marshal until the scripted drill + Drill 2 pass on staging.**

## Promote to production

Repeat steps 1–8 with `production` in place of `staging`:

```bash
# Create the production OTLP secret first (step 1).
aws secretsmanager create-secret \
  --region us-west-2 \
  --name marshal/production/grafana-cloud/otlp-auth \
  --secret-string '{ ... production values ... }'

# Then one-shot.
npm run deploy:production
npm run smoke:production
```

Production uses completely separate resources:

| | Staging | Production |
|---|---|---|
| Stack ID | `MarshalStaging` | `MarshalProduction` |
| Tables | `marshal-staging-incidents`, `marshal-staging-audit` | `marshal-production-incidents`, `marshal-production-audit` |
| Queues | `marshal-staging-incident-events.fifo`, … | `marshal-production-incident-events.fifo`, … |
| ECS cluster / service | `marshal-staging` / `marshal-staging-processor` | `marshal-production` / `marshal-production-processor` |
| Scheduler group | `marshal-staging` | `marshal-production` |
| Log groups | `/marshal/staging/forwarder-diagnostics` | `/marshal/production/forwarder-diagnostics` |
| CFN export prefix | `MarshalStaging*` | `MarshalProduction*` |
| Secret path | `marshal/staging/*` | `marshal/production/*` |
| IAM policies | scoped to staging ARNs only | scoped to production ARNs only |

The staging task role **cannot** read production secrets (and vice versa) — each environment's `SecretsReadPolicy` lists only its own secret ARNs.

## Teardown

`cdk destroy MarshalStaging` (or `MarshalProduction`) leaves DynamoDB tables and Secrets Manager entries behind (RemovalPolicy.RETAIN) so a rebuild can reuse them. To fully remove one environment:

```bash
ENV=staging                                   # or: production

cd marshal/infra
npx cdk destroy "Marshal${ENV^}" --force      # zsh: use `Marshal${(C)ENV}`

aws dynamodb delete-table --region us-west-2 --table-name marshal-${ENV}-incidents
aws dynamodb delete-table --region us-west-2 --table-name marshal-${ENV}-audit
for s in slack/bot-token slack/signing-secret grafana/oncall-token grafana/cloud-token \
         grafana/cloud-org-id statuspage/api-key statuspage/page-id github/token \
         linear/api-key linear/project-id workos/api-key grafana/oncall-webhook-hmac \
         grafana-cloud/otlp-auth; do
  aws secretsmanager delete-secret --region us-west-2 \
    --secret-id "marshal/${ENV}/$s" --force-delete-without-recovery
done
```

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `cdk deploy` fails with `ResourceNotFoundException … marshal/{env}/grafana-cloud/otlp-auth` | The env-scoped OTLP secret doesn't exist yet | Run step 1 for that env, then retry deploy |
| `cdk deploy` stuck at `UPDATE_IN_PROGRESS` → ECS task never becomes healthy | Zod config fail on startup — one of the 12 per-integration secrets is empty for this env | `aws logs tail /marshal/${env}/forwarder-diagnostics --follow` and look for the missing key; `put-secret-value` it and force-new-deployment |
| `npm run typecheck` fails with SDK version errors | Stale `package-lock.json` with drifted peer deps | `rm -rf node_modules package-lock.json && npm install` — details in [`docs/troubleshooting.md`](troubleshooting.md) § "Build / TypeScript errors" |
| `smoke`: webhook returns 5xx | Lambda crashed before HMAC check | Check `/aws/lambda/Marshal${Env}-IngressFunction*` CloudWatch Logs. Usually a missing `GRAFANA_ONCALL_HMAC_SECRET_ARN` or a Secrets Manager permission regression |
| `smoke`: DLQ depth > 0 | Prior deploy left messages in the DLQ | Inspect + drain via `aws sqs receive-message`; re-run smoke. Don't let the DLQ accumulate — the `marshal-{env}-incident-events-dlq-depth` alarm fires at ≥1 |
| Processor task keeps restarting | Likely Bedrock model access not enabled in the region, or a Grafana Cloud credential in `otlp-auth` for this env is stale | Enable model access; rotate the env-scoped `otlp-auth` — sidecars pick up the new value on the next ECS rollover, and the Lambda picks it up on the next cold start (no redeploy needed) |
| Resolve fires but "Bedrock postmortem failed" in logs | `claude-sonnet-4-6` requires an inference profile for on-demand throughput | Switch `src/ai/marshal-ai.ts` model IDs to `us.anthropic.claude-*` profiles; update IAM to allow the profile + wildcard-region foundation-model ARNs. See [`docs/troubleshooting.md`](troubleshooting.md) § "Bedrock errors" |
| Resolve fires but Linear issue doesn't appear | `teamId must be a UUID` — `linear/team-id` secret holds a team key | Reseed with the UUID from `{ teams { nodes { id key } } }`; `aws ecs update-service --force-new-deployment` to roll the task |
| Nudge schedule never fires (no `STATUS_REMINDER_SENT` after 15 min) | `Schedule group marshal-{env} does not exist` in processor logs | CDK must include `CfnScheduleGroup` with `processorService.node.addDependency(scheduleGroup)`. Details in [`docs/troubleshooting.md`](troubleshooting.md) § "EventBridge Scheduler errors" |
| `AutoPublishNotPermitted` error on Approve & Publish | Either real invariant violation, or DDB `Limit + FilterExpression` bug in `verifyApprovalBeforePublish` | Query the audit table directly for the incident — if `STATUSPAGE_DRAFT_APPROVED` exists, it's the Limit+Filter bug. Details in [`docs/troubleshooting.md`](troubleshooting.md) § "Runtime errors" |
| Lambda traces missing from Grafana Cloud Tempo | OTel init failed silently at cold start | Look for `OTel init failed` in the Lambda's CloudWatch log group. Usually a stale `basic_auth` field in the env-scoped `otlp-auth` secret; rotate and invoke the Lambda once to trigger a new cold start |
| Grafana Cloud traces/metrics missing | ADOT sidecar can't authenticate | Check the `otel-collector` container log in CloudWatch. If `401`, the `instance_id`/`api_token` fields in the env's OTLP secret don't match the matching Grafana Cloud stack. |
| Grafana Cloud Loki logs missing | Fluent Bit forwarder error | Check `/marshal/${env}/forwarder-diagnostics` CloudWatch group (meta-log for the forwarder). Usually a wrong `loki_host` for the region. |
| Secret updated via `put-secret-value` but task still uses old value | ECS caches secrets at task start | `aws ecs update-service --cluster marshal-{env} --service marshal-{env}-processor --force-new-deployment` to roll the task |
| Staging event fired in production's war-room channel | Same Slack workspace reused across envs | Use separate Slack workspaces per env. Within one workspace, env-scope the channel prefix by adding `DEPLOYMENT_ENV` to `war-room-assembler.ts`'s `channelName` helper. |

For ongoing operation, see [`artifacts/runbook.md`](../artifacts/runbook.md). For every concrete error we've seen and its fix, see [`docs/troubleshooting.md`](troubleshooting.md).

## Appendix: cleaning up between failed deploys

When a deploy fails and CloudFormation rolls back, most resources get cleaned up automatically. Three categories may linger:

| Resource | Policy | When it orphans | Cleanup |
|---|---|---|---|
| `marshal-{env}-incidents` DDB table | `RETAIN` (both envs) | Any failed deploy after tables were created | Verify `ItemCount: 0`, then `aws dynamodb delete-table` |
| `marshal-{env}-audit` DDB table | `RETAIN` (both envs) | Same | Same |
| Log groups (`/marshal/{env}/processor`, `/marshal/{env}/forwarder-diagnostics`) | `DESTROY` staging / `RETAIN` production | Production only; staging auto-cleans | `aws logs delete-log-group` |

Retention is intentional in production — compliance-relevant audit history and operational diagnostics outlive stack rebuilds. Staging accepts the loss in exchange for frictionless retry loops.

**Canonical cleanup between staging retries:**

```bash
# Check tables are empty (should be 0 if no healthy processor ever ran)
for t in marshal-staging-incidents marshal-staging-audit; do
  aws dynamodb describe-table --region us-west-2 --table-name "$t" \
    --query "{table:TableName,items:ItemCount}"
done

# If both are 0, delete:
for t in marshal-staging-incidents marshal-staging-audit; do
  aws dynamodb delete-table --region us-west-2 --table-name "$t"
done
for t in marshal-staging-incidents marshal-staging-audit; do
  aws dynamodb wait table-not-exists --region us-west-2 --table-name "$t"
done
```

**Stack stuck in `DELETE_FAILED`:**

```bash
# Find which resource(s) failed to delete
aws cloudformation describe-stack-events --region us-west-2 \
  --stack-name MarshalStaging \
  --query 'StackEvents[?ResourceStatus==`DELETE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
  --output table

# Retry delete, retaining problematic resources
aws cloudformation delete-stack --region us-west-2 \
  --stack-name MarshalStaging \
  --retain-resources <LogicalResourceId>
```

Specific known cases are documented in [`docs/troubleshooting.md`](troubleshooting.md).
