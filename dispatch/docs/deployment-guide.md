# Deployment guide

End-to-end walkthrough for bringing Dispatch up in a fresh AWS account. Dispatch is deployed as **two independent CDK stacks** — `DispatchStaging` and `DispatchProduction` — that can coexist in the same account and region. Stand staging up first, run a manual end-to-end, then repeat for production.

If you're rotating credentials on an already-running stack, jump to [`secrets.md`](secrets.md) instead. If a specific error has bitten you, [`troubleshooting.md`](troubleshooting.md) has concrete fixes keyed on the error text.

## 0. Prerequisites

### AWS side

- An AWS account you can deploy to. Export `CDK_DEFAULT_ACCOUNT` + `CDK_DEFAULT_REGION` (the app defaults to `us-east-1`; override with whatever region has Bedrock access enabled):
  ```bash
  export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  export CDK_DEFAULT_REGION=us-west-2
  export AWS_REGION=us-west-2
  ```
- **Bedrock model access** must be enabled in the deployment region for the Claude model the inference profile fans out to. Default is `us.anthropic.claude-sonnet-4-6` (US cross-region inference profile); request access for `anthropic.claude-sonnet-4-6` in **all three** US regions the profile spans (us-east-1, us-east-2, us-west-2) so AWS can route to whichever has spare capacity. Outside the US, override via CDK context `-c bedrockModelId=eu.anthropic.claude-sonnet-4-6` (or `ap.`) and request access in the matching regions.

  Enable via AWS console → Bedrock → Model access → Request access. Deployment succeeds without it; the pipeline fails at run-time with `AccessDeniedException` during `phase.generate`, falls back to a raw skeleton draft, and audits `PIPELINE_FAILURE`.

  **Why an inference profile by default.** Claude 4.x bare model IDs (`anthropic.claude-sonnet-4-6`) only work with provisioned-throughput commitments. On-demand invocation requires a cross-region profile (`us.`/`eu.`/`ap.` prefix). The stack's IAM grants both forms so you can switch back to a bare model ID when you have provisioned capacity. See [`troubleshooting.md`](troubleshooting.md) § "Bedrock errors".
- **SES verified identity.** The `sesFromAddress` you will seed into `dispatch/{env}/runtime-config` must be a verified SES identity (either the email or the sending domain) in the deployment region. If SES is still in sandbox mode, every recipient address in `newsletterRecipients` must also be verified — request production access before you promote to production.
- **CDK bootstrap** in the target region (one-time per account/region — covers both stacks):
  ```bash
  npx cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION
  ```

### Third-party accounts (staging + production)

Provision these **separately** per environment — staging and production each want their own Slack workspace (or at minimum a distinct bot user + review channel) / Linear workspace / Notion database / WorkOS directory / Grafana Cloud stack. Credentials land in env-scoped Secrets Manager paths (`dispatch/staging/*` vs `dispatch/production/*`); sharing them defeats the isolation.

| System | What you need | Where to get it |
|---|---|---|
| **WorkOS** | API key (`sk_live_…`), Client ID (`client_01…`), Directory ID, approver User Management ID (`user_01…`) | [dashboard.workos.com](https://dashboard.workos.com). The Client ID you pass to `cdk deploy -c workosClientId=…` drives the API's JWT `aud` claim and is also seeded into `web-config` for AuthKit. The Directory ID comes from WorkOS → Directory Sync after you connect the IdP. The approver User Management ID (the `user_01…` that goes into `approvers.cosUserId`) only exists after first AuthKit sign-in — bootstrap yourself via the Hosted UI URL: [`secrets.md`](secrets.md) § "Getting a WorkOS User Management ID". |
| **Slack app** | Bot token (`xoxb-…`), announcements channel ID, team channel ID, review channel ID, HR bot user IDs (optional) | Full walkthrough in [`slack-app-setup.md`](slack-app-setup.md). The bot has to be a member of every channel it reads (announcements + team) and the channel it posts to (review). |
| **Linear** | Personal API key, optional `askLabel` override | Linear → Settings → API → Personal API keys. The aggregator reads closed epics, upcoming milestones, and issues tagged with `askLabel` (default `ask`) from the past week. |
| **Notion** | Internal-integration token (`secret_…`), database ID of the all-hands page | Notion → Settings → Connections → Develop or manage integrations. Share the all-hands database with the integration explicitly. |
| **GitHub** | PAT with `repo:read` over the repos you want aggregated | GitHub → Settings → Developer settings → Personal access tokens. Read-only; used for merged-PR fetch. |
| **Grafana Cloud** | OTLP instance ID, Cloud Access Policy token (`glc_…`, `metrics:write`+`traces:write`), OTLP endpoint URL | grafana.com → Connections → OpenTelemetry. See [`secrets.md`](secrets.md) § "The `dispatch/{env}/grafana-cloud` secret" for the JSON payload shape. |

### Local tooling

- Node 24 (Active LTS)
- `aws` CLI ≥ 2.15 with creds for the target account
- Docker (the CDK asset pipeline builds the pipeline + api + web images locally)
- `psql` (for a local migration sanity check; optional)

## Deploy staging first

The rest of this walkthrough deploys `DispatchStaging`. Once staging is live + a manual end-to-end has passed, re-run the same steps with `production` to bring that stack up.

### 1. Seed every secret before the first `cdk deploy`

Every non-DB secret is operator-provisioned — CDK references them by name but does not create them. ECS refuses to start the pipeline / api / web tasks until the task execution role can resolve every `ecs.Secret.fromSecretsManager(...)` reference, so the seed step must run *before* `cdk deploy`, not after.

The seeder (`npm run seed:{env}`) handles both first-seed (create) and rotation (put) transparently:

```bash
cd dispatch
cp secrets.template.json dispatch-secrets.staging.json
# Edit the file — replace every REPLACE_ME with the real value.
# web-config.cookiePassword + grafana-cloud.authHeader auto-derive if left
# empty. `dispatch-secrets.*.json` is gitignored.

npm run seed:staging:dry     # validates shape, no AWS calls
npm run seed:staging         # creates every required secret in Secrets Manager
```

This seeds nine secrets for `dispatch/staging/`: `approvers`, `workos-directory`, `github`, `linear`, `slack`, `notion`, `web-config`, `runtime-config`, `grafana-cloud`. `db-credentials` is the exception — CDK creates and owns it.

Per-key provenance (what comes from which third-party account), JSON schema per payload, and rotation guidance are all in [`secrets.md`](secrets.md). The raw `aws secretsmanager create-secret` commands are there too if you need to seed from a machine without the repo checked out.

### 2. Install + build + synth

From the repo root:

```bash
cd dispatch
npm install
npm run typecheck
npm test
cd infra && npm install && npx cdk synth DispatchStaging
```

Synth does not require Secrets Manager to be populated; it only emits CloudFormation JSON with ARN references. The secrets are read at `cdk deploy` (task def validation) and at task start (ECS pulls values).

### 3. Deploy staging

Pass `workosClientId` (and optional domain overrides) through CDK context so the stack wires the right JWT `aud` claim and CORS allow-list. If you have a Route53 hosted zone in the same account that `stagingDomain` will live under, pass `hostedZoneName` too — the stack will provision an ACM cert (apex + `api.` SANs, DNS-validated), HTTPS listeners on both ALBs with HTTP→HTTPS redirect, and Route53 alias records pointing the bare hostname → web ALB and `api.` → API ALB:

```bash
cd dispatch/infra

# Without DNS+TLS (operator wires it post-deploy, ALBs are HTTP-only on :80):
npx cdk deploy DispatchStaging \
  -c workosClientId=client_01ABCDEFGHIJKLMNOPQRSTUV \
  -c stagingDomain=dispatch-staging.internal.yourco.com

# With DNS+TLS managed by CDK (recommended when you own the hosted zone):
npx cdk deploy DispatchStaging \
  -c workosClientId=client_01ABCDEFGHIJKLMNOPQRSTUV \
  -c stagingDomain=dispatch-staging.fasti.sh \
  -c hostedZoneName=fasti.sh
```

`hostedZoneName` does a `route53.HostedZone.fromLookup` at synth time, so it requires `CDK_DEFAULT_ACCOUNT` + `CDK_DEFAULT_REGION` to be set on the deploy machine. Omit it for env-agnostic synths (CI) and for stacks where the hosted zone lives in a different account.

First deploy takes 15-25 minutes: Docker image builds for pipeline + api + web, ECR pushes, ECS service creation with steady-state waits, Aurora Serverless v2 cluster provisioning (the slow step), ALB provisioning, EventBridge rules, CloudWatch alarms.

On success you'll see CloudFormation outputs:

```
DispatchStaging.WebUrl       = https://DispatchStaging-WebService-...elb.amazonaws.com
DispatchStaging.ApiUrl       = https://DispatchStaging-ApiService-...elb.amazonaws.com
DispatchStaging.DbEndpoint   = dispatchstaging-dispatchdb-....cluster-....rds.amazonaws.com
```

Record these — you'll wire `ApiUrl` into the web service's `API_BASE_URL` env (already set by CDK to `https://api.${domainName}`; if you haven't put a DNS record in front of the ALB yet, override with an ECS service-update) and the WorkOS AuthKit redirect URI into the WorkOS dashboard.

### 4. Run migrations against the new Aurora cluster

The pipeline + API both read + write through the `dispatch` Postgres database. Apply the initial schema (`migrations/001_initial_schema.up.sql`) against the fresh cluster.

**From your laptop (requires VPC reachability via Session Manager, a bastion, or a temporary peered VPN):**

```bash
# Pull the CDK-managed DB credentials.
DB_SECRET=$(aws secretsmanager get-secret-value \
  --region us-west-2 \
  --secret-id dispatch/staging/db-credentials \
  --query SecretString --output text)

export DATABASE_URL="postgres://$(echo "$DB_SECRET" | jq -r '.username'):$(echo "$DB_SECRET" | jq -r '.password' | jq -sRr @uri)@$(echo "$DB_SECRET" | jq -r '.host'):$(echo "$DB_SECRET" | jq -r '.port')/$(echo "$DB_SECRET" | jq -r '.dbname')"

cd dispatch
npm run migrate:up
```

**From inside the VPC (recommended for production):** run the same commands from an EC2 bastion or an ECS exec session on the pipeline task. Aurora is in the isolated subnets and not reachable from the public internet.

### 5. Wire the WorkOS AuthKit redirect URI

In the WorkOS dashboard for the Client ID you passed to `cdk deploy`, add the redirect URI:

- Staging: `https://<stagingDomain>/callback` — e.g. `https://dispatch-staging.fasti.sh/callback`
- Production: `https://<productionDomain>/callback`

Until this is registered, `/callback?code=…` returns a WorkOS `invalid_redirect_uri` error and users can't complete sign-in.

If you deployed **without** `hostedZoneName`, both ALBs are HTTP-only on port 80 and don't have user-facing hostnames yet. You'll need to wire DNS + TLS yourself before the redirect URI works:

1. Request an ACM cert in the deployment region for `<domain>` + `api.<domain>`, DNS-validated against your hosted zone.
2. Add an HTTPS:443 listener on each ALB referencing the cert, forwarding to the existing target group. Optionally swap the existing :80 listener default action to a 301 redirect to HTTPS.
3. Create Route53 alias records: bare `<domain>` → web ALB, `api.<domain>` → API ALB.
4. Then register the WorkOS redirect URI as above.

The CDK-managed path (`-c hostedZoneName=...`) does steps 1-3 automatically and is the recommended approach when the zone lives in the same account.

### 6. Upload the voice-baseline corpus

The newsletter generator loads few-shot examples from `s3://dispatch-voice-baseline-<account>-staging/`. Bootstrap it with at least one example newsletter the Chief of Staff has signed off on (the more, the better — ~5 examples is a good starting point):

```bash
aws s3 cp ./voice-baseline/2026-01-12.md \
  s3://dispatch-voice-baseline-${CDK_DEFAULT_ACCOUNT}-staging/baseline/2026-01-12.md
```

Each file is a plain markdown newsletter. The generator concatenates them into the Bedrock system prompt as few-shot examples. If the bucket is empty, the generator falls back to zero-shot which is legible but not voice-matched.

### 7. Make sure the Slack bot is in every channel it needs

The bot has to be a member of:

- `announcementsChannelId` — read-only ingestion source
- `teamChannelId` — read-only ingestion source
- `slackReviewChannelId` — write target (`postMessage` for "Draft ready" + alerts)

```
/invite @dispatch-bot
```

The Slack aggregator uses `withTimeout(15s)` + `withRetry(3)` per channel — a missing bot membership surfaces as a per-source error, and the pipeline run lands as `PARTIAL` with a warning log (`slack.history-failed`).

### 8. Fire a manual end-to-end run

Both EventBridge rules (PST + PDT) are `enabled: isProd`, so staging does *not* auto-run. Kick off a one-off pipeline task:

```bash
CLUSTER=$(aws cloudformation describe-stacks --region us-west-2 \
  --stack-name DispatchStaging \
  --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue" --output text)

TASKDEF=$(aws ecs list-task-definitions --region us-west-2 \
  --family-prefix DispatchStagingPipelineTask --sort DESC \
  --query 'taskDefinitionArns[0]' --output text)

aws ecs run-task \
  --region us-west-2 \
  --cluster "$CLUSTER" \
  --task-definition "$TASKDEF" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<private-subnet-id>],securityGroups=[<pipeline-sg-id>],assignPublicIp=DISABLED}"
```

Watch the run:

```bash
aws logs tail /dispatch/staging/pipeline --follow
```

Expected sequence: `pipeline.start` → `phase.aggregate` (per-source item counts) → `phase.dedupe` → `phase.rank` → `phase.generate` (Bedrock span + token usage) → `phase.audit_and_notify` → `slack.notify-draft` → `pipeline.exit` with `status: "OK"` or `"PARTIAL"`.

In Slack you should see a "Weekly newsletter draft ready" message in the review channel with a link that leads the approver to `https://<stagingDomain>/review/<draftId>`. Sign in with WorkOS, edit the draft, click **Approve & Send**, and verify:

- Edit event in `audit_events` (`aws logs tail /dispatch/staging/api`)
- SES message ID in the `approved` → `sent` audit chain
- Email lands in your verified-identity inbox

### 9. Enable the schedule for production only

`DispatchStaging` keeps EventBridge rules disabled (`enabled: isProd` in `infra/lib/dispatch-stack.ts:240,248`) so staging doesn't auto-fire while you're still iterating. Production enables both rules at deploy time. If you want staging on a schedule too:

```bash
aws events enable-rule --region us-west-2 --name DispatchStaging-PipelineSchedulePST-...
aws events enable-rule --region us-west-2 --name DispatchStaging-PipelineSchedulePDT-...
```

## Promote to production

Repeat steps 1-8 with `production` in place of `staging`:

```bash
# Seed production secrets (see secrets.md).
# ...

cd dispatch/infra
npx cdk deploy DispatchProduction \
  -c workosClientId=client_01ABCDEFGHIJKLMNOPQRSTUV \
  -c productionDomain=dispatch.internal.yourco.com
```

Production uses completely separate resources:

| | Staging | Production |
|---|---|---|
| Stack ID | `DispatchStaging` | `DispatchProduction` |
| Secret path | `dispatch/staging/*` | `dispatch/production/*` |
| Aurora scaling | 0.5 → 2 ACU, no reader | 0.5 → 8 ACU, one reader |
| Aurora retention | 3-day backup, deletion protection OFF | 14-day backup, deletion protection ON |
| S3 `voice-baseline` | `RemovalPolicy.DESTROY` | `RemovalPolicy.RETAIN` |
| ECS desired counts | 1 api, 1 web | 2 api, 2 web |
| Log retention | `ONE_WEEK` (pipeline), `ONE_MONTH` (api/web) | `THREE_MONTHS` (pipeline), `ONE_MONTH` (api/web) |
| EventBridge rules | disabled | enabled |
| IAM policies | scoped to `dispatch/staging/*` only | scoped to `dispatch/production/*` only |

The staging task roles **cannot** read production secrets (and vice versa) — each environment's inline IAM policy in `infra/lib/dispatch-stack.ts` lists only its own secret ARN prefix.

## Teardown

`cdk destroy DispatchStaging` (or `DispatchProduction`) leaves behind the seven operator-seeded secrets (because CDK never owned them) and, on production, the `voice-baseline` S3 bucket + audit log groups. To fully remove an environment:

```bash
ENV=staging

cd dispatch/infra
npx cdk destroy Dispatch$(echo ${ENV^}) --force

# Delete the operator-seeded secrets.
for s in approvers workos-directory github linear slack notion \
         web-config runtime-config grafana-cloud; do
  aws secretsmanager delete-secret --region us-west-2 \
    --secret-id dispatch/${ENV}/${s} --force-delete-without-recovery
done

# Drain the voice-baseline bucket in production before cdk destroy above.
aws s3 rm --recursive s3://dispatch-voice-baseline-${CDK_DEFAULT_ACCOUNT}-${ENV}/
```

> **Do not delete** `dispatch/production/voice-baseline` lightly. It carries the curated few-shot corpus the Chief of Staff built by hand; rebuilding it is weeks of work, not minutes.

## Common first-deploy failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `cdk deploy` fails with `ResourceNotFoundException … dispatch/{env}/...` | One of the operator-seeded secrets doesn't exist yet | Re-run step 1 for the missing secret, then retry deploy |
| `cdk deploy` stuck at `UPDATE_IN_PROGRESS` → ECS task never becomes healthy | Zod config fail on startup — one of the JSON secrets has a missing or mistyped field | `aws logs tail /dispatch/{env}/pipeline --follow` or `.../api`; look for `ZodError`. `put-secret-value` the fix, then `aws ecs update-service --force-new-deployment` |
| Pipeline task runs once, exits, status `FAILED` with `AccessDeniedException` on Bedrock | Model access not enabled across all regions the inference profile spans | Default profile is `us.anthropic.claude-sonnet-4-6` — request model access for `anthropic.claude-sonnet-4-6` in us-east-1, us-east-2, AND us-west-2 (the profile picks whichever has capacity). See [`troubleshooting.md`](troubleshooting.md) § "Bedrock errors" |
| API 5xx on `/drafts/:id/approve` with `SES.MessageRejected` | `sesFromAddress` not a verified SES identity, or SES still in sandbox and the recipient isn't verified | Verify the identity in SES; request production-access or verify each recipient during bring-up |
| WorkOS sign-in bounces with `invalid_redirect_uri` | The web's redirect URI isn't registered for the Client ID | Add `https://<domain>/callback` in the WorkOS dashboard → Redirects |
| Traces missing from Grafana Cloud | ADOT collector authentication failing | Check the collector container logs at `/dispatch/{env}/otel-collector-{pipeline,api,web}`. The usual cause is a mis-computed `authHeader`; verify it's `Basic ` + base64 of `instanceId:apiToken` |
| Pipeline task lingers in RUNNING after the app exits | Sidecar didn't stop cleanly | The collector is `essential: false` on the pipeline task so the app's exit ends the run; if it stalls, inspect `aws ecs describe-tasks` for container stop-codes. In practice: the collector's `BatchProcessor` has a 10s flush on shutdown |

For every concrete error observed during bring-up with root cause + fix, see [`troubleshooting.md`](troubleshooting.md).

## Appendix: cleaning up between failed deploys

When a deploy fails and CloudFormation rolls back, most resources are cleaned up automatically. Three categories may linger:

| Resource | Policy | When it orphans | Cleanup |
|---|---|---|---|
| `dispatch-voice-baseline-{account}-production` | `RETAIN` (prod only) | Failed production deploy after bucket creation | `aws s3 rm --recursive` then `aws s3api delete-bucket` |
| Aurora cluster `dispatch-...-dispatchdb-...` | `deletionProtection: true` in prod | Failed production deploy after cluster creation | Disable deletion protection via console/CLI, then retry `cdk destroy` |
| CloudWatch log groups (`/dispatch/production/*`) | `RetentionDays.THREE_MONTHS` with no auto-delete | Production only; staging auto-cleans | `aws logs delete-log-group` |

Retention is intentional in production — audit history and operational diagnostics outlive stack rebuilds. Staging accepts the loss in exchange for frictionless retry loops (staging uses `RemovalPolicy.DESTROY` on every destroyable resource).

**Stack stuck in `DELETE_FAILED`:**

```bash
aws cloudformation describe-stack-events --region us-west-2 \
  --stack-name DispatchStaging \
  --query 'StackEvents[?ResourceStatus==`DELETE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
  --output table

# Retry delete, retaining problematic resources:
aws cloudformation delete-stack --region us-west-2 \
  --stack-name DispatchStaging \
  --retain-resources <LogicalResourceId>
```

Specific known cases are documented in [`troubleshooting.md`](troubleshooting.md).
