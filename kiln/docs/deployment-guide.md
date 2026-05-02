# Deployment guide

Stand kiln up from zero in a dedicated AWS sub-account. Target is ≤2 hours for a first-time staging bring-up, assuming all third-party accounts already exist.

Work staging-first. Exercise the drill ([`drills.md`](./drills.md)) before promoting to production.

## 0. Prerequisites

AWS:

- [ ] **Dedicated AWS sub-account** for kiln. Not shared with other workloads. [ADR 0003](./adr/0003-dedicated-aws-subaccount.md) explains why — Bedrock inference logging is account-wide and kiln disables it.
- [ ] AWS CLI v2 configured with an admin role on that account (`aws sts get-caller-identity` works).
- [ ] CDK bootstrap: `npx cdk bootstrap aws://<account-id>/us-west-2`. Only needed once per account/region.
- [ ] Bedrock model access enabled in-console: **Bedrock → Model access → Manage model access** → enable Claude Haiku 4.5, Sonnet 4.6, Opus 4.6 in `us-west-2` AND `us-east-1` (cross-region inference profile).
- [ ] Docker running locally (CDK bundling uses it to build Lambda ZIPs).

Third-party:

- [ ] **WorkOS project** with a `kiln_team_id` custom claim configured on session tokens. See [`workos-setup.md`](./workos-setup.md) for the 10-minute walkthrough.
- [ ] **GitHub App** created and installed on your customer's org — see [`github-app-setup.md`](./github-app-setup.md).
- [ ] **Slack incoming webhook** (optional) if you want alarms pinged to a channel.

Local tooling:

- [ ] Node 24 (check: `node -v`).
- [ ] `npm ci` runs clean in the kiln directory.
- [ ] `npm run lint && npm run typecheck && npm run test:unit` all pass.

## 1. Seed secrets

Before the first `cdk deploy`. kiln's worker Lambda fails to cold-start if its GitHub App PEM is missing. See [`secrets.md`](./secrets.md) for the full inventory + seeder details.

```bash
# Copy the template:
cp secrets.template.json kiln-secrets.staging.json

# Fill in real values (populated files are gitignored):
#   "github-app-private-key": "@file:/path/to/kiln-app-private-key.pem"
#   "slack/webhook-url": "https://hooks.slack.com/..."    (optional — alarms silent without)
#   "linear/api-key": null                                 (optional)
#   "workos/api-key": null                                  (optional)
#   "grafana-cloud/otlp-auth": { "instance_id": "...", "api_token": "glc_..." }  (recommended)
$EDITOR kiln-secrets.staging.json

# Dry-run — no AWS calls, just prints what would be written:
npm run seed:staging:dry

# Seed for real:
npm run seed:staging

# After a clean run, shred the PEM source file:
bash scripts/seed-secrets.sh --env staging --file kiln-secrets.staging.json --shred
```

## 2. Configure

Copy `.env.example` → `.env`. Fill in every value that isn't obvious-fake (`client_REPLACE_ME`, `000000000000`, `0`). Config is validated on Lambda cold start via zod in `src/config.ts` — missing vars fail loudly rather than silently.

Required env (set via CDK context, task env, or pre-deploy shell export; the CDK stack picks them up from `process.env`):

```bash
export CDK_DEFAULT_ACCOUNT=<kiln sub-account id>
export CDK_DEFAULT_REGION=us-west-2
export KILN_ENV=staging
export KILN_WORKOS_ISSUER=https://api.workos.com
export KILN_WORKOS_CLIENT_ID=client_YOUR_ID_HERE
export KILN_WORKOS_TEAM_CLAIM=kiln_team_id
# Optional — Grafana Cloud telemetry (see docs/grafana-cloud-setup.md):
export KILN_TELEMETRY_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-us-west-0.grafana.net/otlp
export OTEL_SERVICE_NAME=kiln
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=staging,service.version=0.1.0"
export KILN_OKTA_AUDIENCE=api://kiln
export KILN_GITHUB_APP_ID=<numeric id from github-app-setup step 2>
export KILN_POLLER_INTERVAL_MINUTES=15
```

The CDK stack reads these at synth time and bakes them into the Lambda env. DynamoDB table names + the SQS queue URL are CDK-generated and injected automatically — don't set them yourself.

## 3. Deploy

```bash
npm ci
npm run typecheck
npm run cdk:synth            # catches most misconfigurations before the AWS call
npm run cdk:diff             # preview
npm run cdk:deploy           # first deploy takes ~6 min (Lambda bundling)
```

On success:

- 1 HTTP API Gateway endpoint
- 3 Lambdas (api, poller, upgrader)
- 6 DynamoDB tables (team-config, pr-ledger, audit-log, changelog-cache, rate-limiter, github-token-cache) — PITR + deletion-protection on the three auditable ones
- 1 FIFO SQS queue + DLQ
- 1 Secrets Manager secret (GitHub App PEM) — seeded in step 1
- 1 Bedrock `ModelInvocationLoggingConfiguration` with `loggingEnabled=false` + AWS Config rule to assert it stays off
- 1 EventBridge schedule (15-min poller cron)
- 1 SNS topic for alarms + 2 CloudWatch alarms (DLQ depth, Bedrock logging drift)

Note the `ApiUrl` output — you'll hit that in step 5.

## 4. Seed a team

kiln doesn't auto-create teams. Write one row into `kiln-team-config` so the poller has something to watch.

```bash
aws dynamodb put-item \
  --table-name kiln-team-config \
  --item file://test-team.json
```

`test-team.json`:

```json
{
  "teamId": {"S": "team-smoke"},
  "orgId": {"S": "acme"},
  "repos": {"L": [{"M": {
    "owner": {"S": "acme"},
    "repo": {"S": "test-repo"},
    "installationId": {"N": "<your github installation id>"},
    "watchedDeps": {"L": [{"S": "react"}]}
  }}]},
  "targetVersionPolicy": {"S": "latest"},
  "reviewSlaDays": {"N": "7"},
  "slackChannel": {"NULL": true},
  "linearProjectId": {"NULL": true},
  "groupingStrategy": {"M": {"kind": {"S": "per-dep"}}},
  "pinnedSkipList": {"L": []},
  "createdAt": {"S": "2026-04-20T00:00:00Z"},
  "updatedAt": {"S": "2026-04-20T00:00:00Z"}
}
```

## 5. Smoke-test

```bash
# Health endpoint (no auth required).
curl -s https://<your-api-url>/healthz
# Expected: {"status":"ok"}

# Trigger the poller once manually (don't wait 15 min).
aws lambda invoke --function-name kiln-poller /tmp/out.json && cat /tmp/out.json
# Expected: {"teamsScanned":1,"depsChecked":1,"enqueued":1,"skipped":0,"errors":0}

# SQS depth should bump to 1, then drain as the worker picks it up.
aws sqs get-queue-attributes \
  --queue-url $(aws sqs get-queue-url --queue-name kiln-upgrade-queue.fifo --query QueueUrl --output text) \
  --attribute-names ApproximateNumberOfMessages

# Worker picks it up, runs the full pipeline. Watch logs.
aws logs tail /aws/lambda/kiln-upgrader --follow
```

Expected sequence in the worker log:

1. `"classifying"` audit write
2. Haiku invocation → breaking-change list
3. `"scanning"` audit write
4. GitHub code search hits
5. `"synthesizing"` audit write
6. Sonnet invocation → patches
7. GitHub branch create + commit + PR open
8. PR ledger insert + `"pr-opened"` audit write

Check the customer repo: a `kiln/react-19.0.0` branch should exist with a PR.

If any step fails, see [`troubleshooting.md`](./troubleshooting.md).

## 6. Fire a drill

Before you trust staging, run the synthetic drill per [`drills.md`](./drills.md) § "Minimal happy-path drill". Validates:

- Idempotency (re-running the same upgrade doesn't open duplicate PRs)
- Cross-tenant isolation (team A's PRs don't leak to team B)
- Rate-limiter behavior under concurrency
- Audit ledger completeness

## 7. Promote to production

Production is an identical CDK stack name-scoped under `-prod`. Separate account, separate GitHub App, separate WorkOS project (or separate clientId within the same project).

```bash
export CDK_DEFAULT_ACCOUNT=<prod sub-account>
export KILN_ENV=production
export KILN_OKTA_AUDIENCE=api://kiln-prod
export KILN_GITHUB_APP_ID=<prod app id>

# Seed prod secrets (prod PEM, prod Slack webhook).
aws secretsmanager create-secret --name "kiln/production/github-app-private-key" --secret-string "$(cat prod.pem)"

# Deploy.
npm run cdk:deploy

# Smoke + drill.
npm run smoke:production
npm run drill:production
```

**Do not** share GitHub Apps, WorkOS clientIds, or DynamoDB tables across envs. A staging bug that nukes audit records must not touch production.

## 8. Subscribe to alarms

CDK creates the SNS topic `kiln-alarms` but does not subscribe anything — that's operational config.

```bash
TOPIC=$(aws sns list-topics --query 'Topics[?ends_with(TopicArn, `:kiln-alarms`)].TopicArn' --output text)

# Email:
aws sns subscribe --topic-arn "$TOPIC" --protocol email --notification-endpoint oncall@example.com

# Slack (via HTTPS webhook):
aws sns subscribe --topic-arn "$TOPIC" --protocol https --notification-endpoint "https://hooks.slack.com/services/..."
```

Confirm the email; Slack subscriptions are immediate.

## Rollback

Rollback = redeploy the previous commit. CDK + CloudFormation handle it.

```bash
git checkout <previous-sha>
npm run cdk:deploy
```

**DynamoDB tables stay.** `RemovalPolicy.RETAIN` on the auditable tables means rollback doesn't lose data. The pr-ledger and audit-log preserve cross-version state.

If you need to recover deleted rows (Ops error), restore via DynamoDB PITR: `aws dynamodb restore-table-to-point-in-time`. Retain the backup at `kiln-audit-log-restore-<ts>` until reconciliation is done.

## Cleanup between failed deploys

First-time deploys occasionally leave orphaned stack resources. If `cdk deploy` fails mid-way:

```bash
# 1. Look at the CloudFormation events.
aws cloudformation describe-stack-events --stack-name KilnStack --max-items 20

# 2. If the stack is in UPDATE_ROLLBACK_FAILED, continue the rollback:
aws cloudformation continue-update-rollback --stack-name KilnStack

# 3. If totally stuck, delete + redeploy.
aws cloudformation delete-stack --stack-name KilnStack
# Wait for deletion; auditable tables will NOT be deleted due to RETAIN.
npm run cdk:deploy
```

Deletion-protected tables (`kiln-team-config`, `kiln-pr-ledger`, `kiln-audit-log`) survive stack deletion. On re-deploy, CDK imports them if the table name matches — your tenant data is safe. If you truly want a clean slate, temporarily remove `deletionProtection: true` from `storage-construct.ts`, deploy, destroy, then restore the flag before the next deploy.

## Common issues

See [`troubleshooting.md`](./troubleshooting.md) for the full catalog. First-deploy greatest hits:

| Symptom | First check |
|---|---|
| `The model ID is invalid for Bedrock inference` | Model access enabled in Bedrock console for both `us-west-2` + `us-east-1`? |
| Lambda cold-start `Runtime.ImportModuleError` | Secrets Manager has the GitHub App PEM under the correct name? |
| `cdk deploy` fails with `inference logging configuration already exists` | Another stack in the same account has set it — this account is not dedicated. Move to a fresh account or delete the conflicting config |
| `cdk synth` fails type check | Node 24? `npm ci` run against the right `package.json`? |
