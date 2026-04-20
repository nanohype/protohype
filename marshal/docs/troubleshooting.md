# Troubleshooting catalogue

Every concrete error Marshal has surfaced during bring-up, with root cause and fix. Keyed on the exact error text where possible so you (or the next operator) can grep-find the answer instead of re-diagnosing.

Sections:
- [CloudFormation / CDK deploy errors](#cloudformation--cdk-deploy-errors)
- [Build / TypeScript errors](#build--typescript-errors)
- [ECS task startup errors](#ecs-task-startup-errors)
- [Runtime errors (processor logs)](#runtime-errors-processor-logs)
- [Slack errors](#slack-errors)
- [Secrets Manager errors](#secrets-manager-errors)
- [Grafana errors](#grafana-errors)
- [Bedrock errors](#bedrock-errors)
- [Linear errors](#linear-errors)
- [EventBridge Scheduler errors](#eventbridge-scheduler-errors)
- [Drill-specific gotchas](#drill-specific-gotchas)

## CloudFormation / CDK deploy errors

### `Resource of type 'AWS::DynamoDB::Table' with identifier 'marshal-…-incidents' already exists`

**Cause:** The incidents + audit tables have `RemovalPolicy.RETAIN`. A previous failed deploy rolled back but left the tables behind. CDK tries to create new tables with the same names and CFN rejects the collision.

**Fix:** Delete the orphaned tables (they have zero items if no healthy processor ever wrote to them — verify before deleting):

```bash
for t in marshal-{env}-incidents marshal-{env}-audit; do
  aws dynamodb describe-table --region us-west-2 --table-name "$t" \
    --query 'Table.ItemCount' --output text
done
# If both are 0:
for t in marshal-{env}-incidents marshal-{env}-audit; do
  aws dynamodb delete-table --region us-west-2 --table-name "$t"
  aws dynamodb wait table-not-exists --region us-west-2 --table-name "$t"
done
```

Then re-run `npm run cdk:deploy:{env}`. RETAIN is correct for production (compliance + post-incident review); the cleanup overhead is accepted in exchange.

### `Resource of type 'AWS::Logs::LogGroup' with identifier '/marshal/…' already exists`

**Cause:** On staging, log groups should have `RemovalPolicy.DESTROY` so rollback cleans them up. If you see this in staging, the stack code has a regression to the RETAIN-on-staging behavior. In production, RETAIN is intentional.

**Fix:**

```bash
aws logs delete-log-group --region us-west-2 \
  --log-group-name /marshal/{env}/forwarder-diagnostics
aws logs delete-log-group --region us-west-2 \
  --log-group-name /marshal/{env}/processor
aws logs delete-log-group --region us-west-2 \
  --log-group-name /aws/lambda/marshal-{env}-bedrock-logging-none
# plus any others listed in the error
```

### `cannot change the physical resource ID from X to Y during deletion`

**Cause:** A CloudFormation Custom Resource's handler returned a PhysicalResourceId on Update/Delete that's different from the one Slack persisted on Create. CFN treats this as renaming the resource mid-delete and refuses.

Affected Marshal custom resources: `BedrockInvocationLoggingNone`.

**Fix in code:** the handler must echo `event.PhysicalResourceId` on Update/Delete, not synthesize a new one. Marshal's handler was fixed in the post-audit hardening commit. If you see this, check that `src/handlers/bedrock-logging-none.ts` uses:

```typescript
const physicalResourceId = event.RequestType === 'Create'
  ? `bedrock-invocation-logging-none-${process.env['AWS_REGION']}`
  : event.PhysicalResourceId;
```

**Fix for a stuck stack:** the stack is in `DELETE_FAILED` state. Tell CFN to skip the problem resource and continue deletion:

```bash
aws cloudformation delete-stack --region us-west-2 \
  --stack-name Marshal{Env} \
  --retain-resources BedrockInvocationLoggingNone
aws cloudformation wait stack-delete-complete --region us-west-2 \
  --stack-name Marshal{Env}
```

The Bedrock account-level logging setting (logging-disabled) persists regardless — it's an AWS account property, not a stack-owned resource. Retaining the CFN logical resource just means CFN forgets about tracking it.

### `ChangeSet failed early validation: Resource of type 'AWS::ECS::TaskDefinition' with identifier 'marshal-…-processor' already exists`

**Cause:** Rare — usually means a previous deploy partially succeeded and left an ECS task-def family behind that CDK doesn't see.

**Fix:** task-def families are cumulative in AWS — CDK expects to create a NEW revision. If this error fires, CFN is trying to create the family itself (revision :1). List revisions:

```bash
aws ecs list-task-definitions --region us-west-2 \
  --family-prefix marshal-{env}-processor --status ACTIVE
```

If revisions exist, deregister them:

```bash
for rev in $(aws ecs list-task-definitions --region us-west-2 \
    --family-prefix marshal-{env}-processor --status ACTIVE \
    --query 'taskDefinitionArns' --output text); do
  aws ecs deregister-task-definition --region us-west-2 --task-definition "$rev"
done
```

## Build / TypeScript errors

### `npm run typecheck` fails with 17 errors spanning lib-dynamodb, secrets-manager, scheduler, OTel — but runtime works

**Cause:** Stale `package-lock.json`. The peer-dependency graph drifted between incompatible minor versions — typically `@aws-sdk/util-dynamodb` at an older release than `@aws-sdk/lib-dynamodb` + `@aws-sdk/client-dynamodb`, which makes `GetCommand`'s middleware type signature mismatch. You'll see errors like:

```
Argument of type 'GetCommand' is not assignable to parameter of type 'Command<any, GetCommandInput, any, GetItemCommandOutput | GetCommandOutput, …>'
Module '"@aws-sdk/client-secrets-manager"' has no exported member 'SecretsManagerClient'
```

Both of these are type-declaration issues — the runtime exports are intact (that's why `npm run dev` works even while typecheck fails).

**Fix:** clean reinstall pins all transitive AWS SDK versions to the same minor release:

```bash
rm -rf node_modules package-lock.json
npm install
npx tsc --noEmit   # should now report 0 errors
```

Commit the refreshed `package-lock.json`. CI uses `npm ci` which needs the lockfile to be consistent.

### `Unexpected end of file in source map` during `cdk deploy` bundling

**Cause:** esbuild, when told to emit sourcemaps, tries to follow `//# sourceMappingURL=…` comments in dependencies and merge them. Several `@opentelemetry/*` packages ship truncated/malformed `.js.map` files that esbuild refuses to parse.

**Fix:** in `infra/lib/marshal-stack.ts`, the ingress Lambda's bundling has `sourceMap: false` which disables both generation AND following of existing sourcemap comments. Tradeoff: Lambda stack traces lose line numbers; file names remain. If you really want sourcemaps for the Lambda, switch to `sourceMapMode: SourceMapMode.INLINE` and accept that specific OTel packages must be marked external.

## ECS task startup errors

### `ResourceInitializationError: unable to retrieve secret from asm: … AccessDeniedException … is not authorized to perform: secretsmanager:GetSecretValue`

**Cause:** The **task execution role** (not the task role) lacks `GetSecretValue` permission on the secret ARN. Or the policy's resource ARN doesn't match the request ARN shape.

**Fix:** Marshal's stack grants `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:…:secret:marshal/{env}/*` to both the task role AND the execution role. If you see this after a deploy, check `infra/lib/marshal-stack.ts` that `secretsReadPolicy` is attached to `processorTaskDefinition.obtainExecutionRole()`, not just the task role.

### `ResourceInitializationError: … Secrets Manager can't find the specified secret` (with partial ARN in error)

**Cause:** The task def's `valueFrom` field contains a **partial ARN** (without Secrets Manager's 6-char random suffix). Secrets Manager's GetSecretValue requires either the full ARN with suffix or the secret's plain name — partial ARNs aren't valid.

This was `Secret.fromSecretNameV2`'s default behavior. Marshal's fix uses an `AwsCustomResource` that runs `DescribeSecret` at deploy time and resolves the full suffixed ARN via `Secret.fromSecretCompleteArn`.

**Verify the fix is deployed:**

```bash
aws cloudformation describe-stack-resources --region us-west-2 \
  --stack-name Marshal{Env} \
  --query 'StackResources[?contains(LogicalResourceId, `Lookup`)].LogicalResourceId' \
  --output text
```

You should see 15 resources ending in `Lookup` (one per secret).

### `Essential container in task exited` + `exec format error` in the container's logs

**Cause:** Architecture mismatch. The Docker image was built for one architecture (usually arm64 on Apple Silicon builders), Fargate is running on another (amd64 by default). The binary can't execute → task dies on container start.

**Fix:** Two parts in `infra/lib/marshal-stack.ts`, both required:

```typescript
// 1. Task def platform
const processorTaskDefinition = new ecs.FargateTaskDefinition(this, 'ProcessorTaskDef', {
  runtimePlatform: {
    cpuArchitecture: ecs.CpuArchitecture.ARM64,
    operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
  },
  // ...
});

// 2. Docker asset build platform (forces buildx/QEMU on x86 builders)
new ecr_assets.DockerImageAsset(this, 'ProcessorImage', {
  platform: ecr_assets.Platform.LINUX_ARM64,
  // ...
});
```

Both are pinned to ARM64 (Graviton on Fargate: cheaper + faster native build on Apple Silicon).

### `Invalid request provided: Create TaskDefinition: When a firelensConfiguration object is specified, at least one container has to be configured with the awsfirelens log driver`

**Cause:** The task def has a Fluent Bit firelens log router but no container uses it as a consumer. Marshal splits sidecars by environment: staging has no Fluent Bit (processor logs direct to CloudWatch via `awsLogs`), production has Fluent Bit routing to Loki via `firelens`.

**Fix:** verify `addFirelensLogRouter` is inside the `if (props.environment === 'production')` block in `infra/lib/marshal-stack.ts`. If staging is failing this validation, the if-condition got flipped or removed.

### `Task failed container health checks` + all containers exit 0

**Cause:** ECS health check command exits non-zero. Exit 0 on the container means it received SIGTERM from ECS (clean shutdown after ECS decided the container is unhealthy).

Marshal's previous regression: `curl -f http://localhost:3001/health || exit 1` — but alpine doesn't ship curl. Every probe exited `curl: not found` with exit 125, ECS counted 3 consecutive failures, killed the task.

**Fix:** use `wget`, which alpine busybox ships:

```typescript
healthCheck: {
  command: ['CMD-SHELL', 'wget -q --spider http://localhost:3001/health || exit 1'],
  // ...
}
```

### `Required env not set: X` in processor logs, exit code 1, circuit breaker trips

**Cause:** The processor's `src/utils/env.ts:requireEnv` throws when a required env var is absent. Means the CDK task def didn't inject `X` — either the env var was added to the app's requireEnv list but not wired in the stack, or a secret is seeded with a missing key.

**Fix:** audit the gap between `src/index.ts:requireEnv([...])` and the CDK task def's `environment:` + `secrets:` blocks. Every name in requireEnv must have a corresponding source in the stack. Marshal's past misses: `SLACK_APP_TOKEN`, `LINEAR_TEAM_ID`, `NUDGE_EVENTS_QUEUE_ARN`, `SCHEDULER_GROUP_NAME`.

### `ECS Deployment Circuit Breaker was triggered` — no other detail

This is the generic CFN wrapper around "ECS tried to launch tasks, they kept failing, ECS gave up". It's always a symptom; the real error is in the stopped-task details:

```bash
# Get the arn of the last stopped task
aws ecs list-tasks --region us-west-2 --cluster marshal-{env} --desired-status STOPPED

# Get the stoppedReason + container exit codes
aws ecs describe-tasks --region us-west-2 --cluster marshal-{env} \
  --tasks <arn-from-above> \
  --query 'tasks[0].{stoppedReason:stoppedReason,containers:containers[].{name:name,exitCode:exitCode,reason:reason}}'

# Tail whatever log groups survived (in staging, all of them — DESTROY policy means
# they were already wiped on prior rollbacks, so the current run's logs are fresh):
aws logs tail /marshal/{env}/processor --region us-west-2 --since 15m
aws logs tail /marshal/{env}/forwarder-diagnostics --region us-west-2 --since 15m
```

If the stoppedReason is cryptic ("scaling activity initiated by deployment …"), that's the task ECS killed *after* declaring the deploy failed, not the failing task. List more stopped tasks and look at earlier ones.

## Runtime errors (processor logs)

### `AutoPublishNotPermitted: Attempted to publish Statuspage.io incident for incident_id=… without a confirmed STATUSPAGE_DRAFT_APPROVED audit record`

**Cause — two possibilities:**

1. **Genuine invariant violation** — an unauthorised caller tried to publish without approval. Investigate immediately; this should be impossible through the normal code path (CI grep-gate blocks any call to `createIncident` outside the gate file).

2. **False positive from DDB `Limit` + `FilterExpression` interaction** — DynamoDB applies `Limit` BEFORE `FilterExpression`. A query with `Limit: 1` returns the earliest audit event by SK (e.g. `WAR_ROOM_CREATED`), then filters it out, yielding an empty `Items` array even when `STATUSPAGE_DRAFT_APPROVED` exists. The gate interprets empty Items as "no approval" and refuses.

**Fix:** `src/utils/audit.ts:verifyApprovalBeforePublish` must NOT use `Limit` when combined with `FilterExpression`. The per-incident audit trail is bounded (tens of events), so scanning all of them under `ConsistentRead` is trivial. If you see this error and the audit table DOES have a `STATUSPAGE_DRAFT_APPROVED` row for the incident, the fix regressed — remove the `Limit` parameter.

Quick diagnosis — check whether the approval row exists:

```bash
aws dynamodb query --region us-west-2 --table-name marshal-{env}-audit \
  --key-condition-expression 'PK = :pk' \
  --expression-attribute-values '{":pk":{"S":"INCIDENT#<incident-id>"}}' \
  --query 'Items[*].[timestamp.S,action_type.S]' --output table
```

If `STATUSPAGE_DRAFT_APPROVED` is there, it's the Limit+Filter bug. If it isn't, the approval write actually failed — look for "CRITICAL: Audit write failed" in the processor logs around the click time.

### `Pass options.removeUndefinedValues=true to remove undefined values from map/array/set`

**Cause:** The DynamoDB DocumentClient's default marshaler rejects `undefined` field values. Marshal's `INCIDENT_RESOLVED` audit write passes `linear_issue_id: linearDraft?.linear_issue_id` — if Linear creation failed upstream, `linearDraft` is `undefined`, so the field resolves to `undefined`, and the marshaler throws.

**Fix:** `src/wiring/dependencies.ts` constructs the doc client with `{ marshallOptions: { removeUndefinedValues: true } }`. If this error returns, the option got removed — restore it. Prefer the option over individual `if (x) { key: x }` guards at call sites because the fields leak in through `linearDraft?.field` patterns throughout the codebase.

### `Schedule group marshal-{env} does not exist.`

See [EventBridge Scheduler errors](#eventbridge-scheduler-errors) below.

### `conversations.create: An API error occurred: name_taken`

**Cause:** Two war-room channels tried to claim the same Slack channel name on the same day. Happens when two incidents share a prefix (real OnCall alert IDs with adjacent numeric values, or multiple drills on the same day whose first 6 chars of `incident_id` are identical).

**Fix:** `src/services/war-room-assembler.ts:channelName` appends a cryptographic nonce (6 hex chars, ~16M entropy) to the channel name:

```
marshal-p1-YYYYMMDD-<id-prefix>-<nonce>
```

If you see `name_taken` with this fix in place, it means either (a) Slack workspace-wide uniqueness collided with a pre-existing archived channel (archived channels still reserve the name), or (b) the 16M entropy rolled an unlucky duplicate. Unarchive + rename the pre-existing channel, or retry the drill — the nonce will be different on the next run.

## Slack errors

### `/marshal is not a valid command`

**Cause:** The slash command isn't registered in the Slack app config.

**Fix:** See [`docs/slack-app-setup.md`](slack-app-setup.md) § 5 — declare the command in the Slack app, reinstall, reseed the rotated bot token, force ECS rollover.

### Processor log shows `slack.<api-call>: An API error occurred: missing_scope`

**Cause:** The bot token lacks a scope required for that API call.

**Fix:** Slack app → OAuth & Permissions → add the scope called out in the `needed:` field of the error response. Reinstall. Reseed the rotated `xoxb-…` token. See [`docs/slack-app-setup.md`](slack-app-setup.md) § 2 for the full scope list Marshal needs.

Specific known cases:
- `pins.add: missing_scope` → need `pins:write`
- `users.lookupByEmail: missing_scope` → need `users:read.email`
- `conversations.create: missing_scope` → need `groups:write` (for private channels) or `channels:manage` (for public)

### `401 Invalid signature` on the webhook Lambda

**Cause:** The HMAC signature in the `x-grafana-oncall-signature` header doesn't match what the Lambda computes from `HMAC-SHA256(body, secret)`. Either:
- The secret the sender used ≠ the secret the Lambda cached
- The body was mutated in transit (unlikely — API Gateway passes through)

**Fix:**

1. Verify the sender is using the same secret in `marshal/{env}/grafana/oncall-webhook-hmac`.
2. If you rotated the secret recently, the Lambda's in-memory cache (5-min TTL) may be stale. Force a cold start:
   ```bash
   aws lambda update-function-configuration --region us-west-2 \
     --function-name <IngressFunctionName> \
     --environment "Variables={LOG_LEVEL=info}"
   ```
   Next invocation reloads the secret from Secrets Manager.

### "No channel created" — but Marshal's logs say `War room assembled`

**Cause:** The channel WAS created. It's **private** (Marshal creates all war rooms with `is_private: true`) so non-members can't see it in the channel browser. The bot is the only member; you aren't.

**Fix:** see [`docs/drills.md`](drills.md) § "Invite yourself to the drill channel" for the API invocation. There's no Slack UI self-invite path for private channels unless you're a workspace Admin.

## Secrets Manager errors

### `ResourceNotFoundException: Secrets Manager can't find the specified secret`

Three distinct causes — check in this order:

1. **Secret doesn't exist.** `aws secretsmanager describe-secret --secret-id marshal/{env}/<name>` returns `ResourceNotFoundException`. Run the seeder: `npm run seed:{env}`.

2. **Secret is scheduled for deletion.** `describe-secret` succeeds but shows `DeletedDate`. Restore:
   ```bash
   aws secretsmanager restore-secret --region us-west-2 \
     --secret-id marshal/{env}/<name>
   ```

3. **Task def has the wrong ARN shape** (partial ARN without suffix). Resolved by Marshal's `AwsCustomResource` lookup pattern — see the ECS startup section above.

### Seeder shows `OK : put:` for every secret but task can't find them

**Cause:** Profile mismatch. Your AWS CLI profile for seeding points at one account; your CDK deploy context points at another. The secrets got written to the wrong account.

**Fix:**

```bash
# Confirm both use the same account
aws sts get-caller-identity
aws sts get-caller-identity --profile <whatever-you-used-for-cdk>

# And that the deployed stack is in that account
aws cloudformation describe-stacks --region us-west-2 --stack-name Marshal{Env} \
  --query 'Stacks[0].StackId'
```

All three should reference the same AWS account ID.

## Grafana errors

### OnCall curl returns `530 Origin Unreachable`

**Cause:** Wrong OnCall URL. OnCall runs on its own cluster topology, independent of your Grafana Cloud stack's cluster. A stack in `prod-us-west-0` can have its OnCall at `oncall-prod-us-central-0.grafana.net`.

**Fix:** find the authoritative URL by opening OnCall in the Grafana UI + copying the base from the browser URL. Update `GRAFANA_ONCALL_BASE_URL` in the task def env (currently hardcoded in `src/wiring/dependencies.ts` as `https://oncall-prod-us-central-0.grafana.net`; override if your region differs).

### OnCall returns `404` on `/oncall/api/v1/integrations`

**Cause:** Token is valid but doesn't have permission to hit OnCall's API. Or you've used the wrong URL entirely.

**Fix:** OnCall's REST API is at `/oncall/api/v1/…` (note the `/oncall/` prefix). `Authorization: <token>` header — no `Bearer` prefix. See [`docs/secrets.md`](secrets.md) § "Grafana credentials — which is which" for the full auth matrix.

### Grafana Cloud Mimir returns `401`

**Cause:** Either the `glc_…` read token lacks `metrics:read` scope, or the `cloud-org-id` (Mimir tenant ID) doesn't match the token's issuing stack.

**Fix:**
1. Confirm the access policy has `metrics:read` at grafana.com → Administration → Cloud access policies.
2. Confirm `cloud-org-id` is the Mimir tenant ID (shown on grafana.com → Connections → Hosted Prometheus Metrics → "Username / Instance ID"), not the stack-level instance ID.

## Bedrock errors

### `Invocation of model ID anthropic.claude-sonnet-4-6 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.`

**Cause:** AWS Bedrock requires Claude 4.x-family models to be invoked through a **cross-region inference profile** when using on-demand throughput. Direct foundation-model invocation only works with provisioned-throughput commitments (pre-purchased capacity, $$). Marshal uses on-demand throughput — the cheap path for bursty incident volume.

**Fix:** in `src/ai/marshal-ai.ts`, switch the model IDs from foundation-model names to inference-profile IDs. For the US geo (us-west-2, us-east-1, us-east-2):

```ts
const SONNET_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
const HAIKU_MODEL_ID  = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
```

The `us.` prefix is the cross-region inference profile for the US — AWS routes each request across multiple regions for capacity availability. Equivalent profiles exist for EU (`eu.`) and APAC (`apac.`).

**Also update IAM** in `infra/lib/marshal-stack.ts`. The task role's `bedrock:InvokeModel` permission needs:

```ts
resources: [
  // The inference-profile ARN itself
  `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6`,
  `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
  // The underlying foundation models the profile routes to — wildcard region
  // because the profile hits multiple regions.
  `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`,
  `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
]
```

**Degraded fallback:** `MarshalAI.generatePostmortemSections()` has an inline fallback template that renders a skeleton postmortem when Bedrock fails. An incident resolve with Bedrock failing still produces a Linear issue, but the issue body is generic. Look for `"Bedrock postmortem failed — returning template"` in the processor logs.

## Linear errors

### `Argument Validation Error - teamId must be a UUID.`

**Cause:** Linear's GraphQL API expects **team UUIDs** (e.g. `a1b2c3d4-e5f6-7890-abcd-1234567890ab`), not team **keys** (short identifiers like `ENG` or `PLAT`). The seeded `linear/team-id` secret holds a team key instead of a UUID.

**Fix:** get the team UUID via the GraphQL API and reseed:

```bash
LINEAR_KEY=$(aws secretsmanager get-secret-value --region us-west-2 \
  --secret-id marshal/{env}/linear/api-key --query SecretString --output text)

curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_KEY" -H "Content-Type: application/json" \
  -d '{"query":"{ teams { nodes { id key name } } }"}' | jq '.data.teams.nodes'

# Find the team you want, copy its `id` field, then:
aws secretsmanager put-secret-value --region us-west-2 \
  --secret-id marshal/{env}/linear/team-id \
  --secret-string '<the-UUID>'

# Force ECS to re-pull the secret (see "ECS task has stale secret value" below)
aws ecs update-service --region us-west-2 \
  --cluster marshal-{env} --service marshal-{env}-processor \
  --force-new-deployment
```

Same pattern for `linear/project-id` (also a UUID, from `{ projects { nodes { id name } } }`).

## EventBridge Scheduler errors

### `Schedule group marshal-{env} does not exist.` — nudge never fires

**Cause:** The `NudgeScheduler.scheduleNudge` call targets a named schedule group, but the group wasn't created at deploy time. `CreateSchedule` errors; `scheduleNudge` has a try/catch that warn-logs and continues, so the rest of assembly succeeds but the 15-min nudge never arrives.

**Fix:** `infra/lib/marshal-stack.ts` must include a `CfnScheduleGroup` construct named `${name.prefix}` AND an explicit `processorService.node.addDependency(schedulerGroup)` so the service doesn't start handling alerts before the group is up. If you see this error with the fix in place, check that the group actually exists:

```bash
aws scheduler list-schedule-groups --region us-west-2 \
  --query 'ScheduleGroups[?Name==`marshal-{env}`]'
```

If empty, CDK failed to create it (rare — check CFN events for the `ScheduleGroup` resource).

**Recover an in-flight incident whose nudge was dropped:** create the schedule manually. See `docs/troubleshooting.md` history or `scripts/fire-drill.sh` output for the CLI pattern — `aws scheduler create-schedule` with the queue ARN as target.

## ECS task has stale secret value after rotation

**Symptom:** you updated a secret via `aws secretsmanager put-secret-value`, but the running task keeps using the old value — Linear still complains about the old team ID, or Slack rejects the old bot token.

**Cause:** ECS pulls secret values at **task start**, not on every invocation. The running task has the old value cached until it's replaced.

**Fix:** force a new deployment, which rolls the task with fresh secrets:

```bash
aws ecs update-service --region us-west-2 \
  --cluster marshal-{env} --service marshal-{env}-processor \
  --force-new-deployment
aws ecs wait services-stable --region us-west-2 \
  --cluster marshal-{env} --services marshal-{env}-processor
```

For Lambda (webhook ingress), the HMAC secret is cached in-handler with a 5-min TTL and version-aware invalidation, so rotations usually propagate within 5 minutes. If you need it immediately, update the Lambda's env (trivial no-op change) to force a cold start:

```bash
aws lambda update-function-configuration --region us-west-2 \
  --function-name <IngressFunctionName> \
  --environment "Variables={LOG_LEVEL=info}"
```

## Drill-specific gotchas

### Drill fired, HTTP 200, no channel visible

Same as the Slack section above — the channel is private. See [`docs/drills.md`](drills.md) § "Invite yourself to the drill channel".

### Drill fired, but processor logs nothing

**Cause:** SQS message delivered but processor container either hasn't rolled to the new task def or has crashed.

**Fix:**

```bash
# Is the service running at all?
aws ecs describe-services --region us-west-2 --cluster marshal-{env} \
  --services marshal-{env}-processor \
  --query 'services[0].{desired:desiredCount,running:runningCount,events:events[0:3].message}'

# What's in the queue?
aws sqs get-queue-attributes --region us-west-2 \
  --queue-url <IncidentEventsQueueUrl> \
  --attribute-names ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible

# If `NotVisible` > 0, the message is being processed (or the processor is hung)
```

### Drill resolved but incident state stays `ROOM_ASSEMBLED`

**Cause:** The resolved-state webhook was accepted but the processor's `ALERT_RESOLVED` handler didn't run. Most likely `handlers/alert-resolved.ts` isn't registered in the event registry, or the processor is stopped.

**Fix:** check the processor is running (see above), then the event registry:

```bash
aws logs tail /marshal/{env}/processor --region us-west-2 --since 5m \
  --filter-pattern '"Marshal processor started"'
```

The startup log line includes `incident_events: [...]` — confirm `ALERT_RESOLVED` is in that list.

---

If you hit something not covered here, add it to this doc with the error text, cause, and fix. The next operator (possibly future-you in 3 months) will thank you.
