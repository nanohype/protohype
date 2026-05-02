# Troubleshooting

Keyed on exact error text or log-line so you can grep from an alarm body straight to the fix. Organized by subsystem — if you don't know which one, start at the top.

Sections:
- [CDK / CloudFormation deploy errors](#cdk--cloudformation-deploy-errors)
- [Build + typecheck errors](#build--typecheck-errors)
- [Lambda cold start + runtime errors](#lambda-cold-start--runtime-errors)
- [DynamoDB errors](#dynamodb-errors)
- [SQS + idempotency](#sqs--idempotency)
- [Bedrock](#bedrock)
- [GitHub App](#github-app)
- [WorkOS / JWT](#workos--jwt)
- [Telemetry / Grafana Cloud](#telemetry--grafana-cloud)
- [Poller](#poller)
- [Drill-specific gotchas](#drill-specific-gotchas)

---

## CDK / CloudFormation deploy errors

### `Resource handler returned message: "Invocation logging configuration already exists for this account"`

**Cause:** Another stack (or a manual API call) in the same AWS account already set `ModelInvocationLoggingConfiguration`. The resource is account-scoped; only one configuration per account.

**Fix:** this account is not dedicated. Either:
1. Move kiln to a fresh AWS sub-account (recommended — see [ADR 0003](./adr/0003-dedicated-aws-subaccount.md)), OR
2. `aws bedrock delete-model-invocation-logging-configuration` (destructive — you're removing whatever the other workload set), then redeploy.

If you choose (2), audit what's in the account and whether the owning team needs logging on. Don't disable logging for another team's workload.

### `CREATE_FAILED: Custom::AWS-... DescribeSecret access denied`

**Cause:** You ran `cdk deploy` before seeding the Secrets Manager secret. CDK tries to look up the ARN via a custom resource and fails because the secret doesn't exist yet.

**Fix:** seed the secret first (see [`secrets.md`](./secrets.md) step 1), THEN `cdk deploy`.

### `The table 'kiln-audit-log' already exists`

**Cause:** Auditable DynamoDB tables have `RemovalPolicy.RETAIN`. A previous `cdk destroy` left them behind; a new `cdk deploy` under the same account tries to re-create them.

**Fix:** if you intended to reuse them, `cdk deploy` will import via the same name — should not fail. If it does, you probably have two stacks colliding on the same table name (staging in the same account as production?). Rename the stack or move envs to separate accounts.

### `UPDATE_ROLLBACK_FAILED` stuck state

**Cause:** a rollback hit a resource it can't clean up (typically a Lambda that's still executing, or a DynamoDB write capacity change in progress).

**Fix:**
```bash
aws cloudformation continue-update-rollback --stack-name KilnStack
```
If a specific resource is wedged: `--resources-to-skip <LogicalResourceId>` (skips it during rollback — audit the result manually).

### `User is not authorized to perform bedrock:PutModelInvocationLoggingConfiguration`

**Cause:** the deploy role can't set Bedrock account config.

**Fix:** the role needs `bedrock:PutModelInvocationLoggingConfiguration` + `bedrock:GetModelInvocationLoggingConfiguration` at the account level. Attach a policy that allows both on `*`.

---

## Build + typecheck errors

### `error TS2307: Cannot find module 'X' or its corresponding type declarations`

**Cause:** dep added to code but not to `package.json`, or `npm ci` wasn't run after a `package.json` change.

**Fix:** `npm install` the missing dep and commit the `package-lock.json` change.

### `error TS2554: Expected X arguments, but got Y` in an adapter file

**Cause:** a port interface signature changed in `src/core/ports.ts` but the adapter wasn't updated. Or a fake in `tests/fakes.ts` is stale.

**Fix:** grep for the port type name in `src/adapters/` and `tests/fakes.ts` and update both call sites. The core/adapters boundary is ESLint-enforced but the compiler is the first-line check.

### ESLint: `'@aws-sdk/client-X' is restricted from being used` in a `src/core/` file

**Cause:** someone imported an SDK into the pure domain layer. The boundary is enforced — see [ADR 0002](./adr/0002-hexagonal-core-adapters-split.md).

**Fix:** move the side-effect to an adapter under `src/adapters/`. If core/ truly needs the *type* but not the runtime import, use `import type` — type-only imports aren't restricted.

---

## Lambda cold start + runtime errors

### `Runtime.ImportModuleError: could not load GitHub App secret: AccessDenied`

**Cause:** the worker Lambda's IAM role doesn't have `secretsmanager:GetSecretValue` on the correct ARN. Usually a misaligned env between CDK and the deployed stack.

**Fix:**
```bash
# Confirm the ARN the Lambda's env points at:
aws lambda get-function-configuration --function-name kiln-upgrader \
  --query 'Environment.Variables.KILN_GITHUB_APP_SECRET_ARN' --output text

# Confirm the policy:
aws iam get-role-policy --role-name <WorkerRole...> --policy-name <inline>

# If they don't match, re-deploy — CDK will regenerate the policy.
npm run cdk:deploy
```

### `Runtime.ImportModuleError: Invalid kiln configuration: workos.clientId: String must contain at least 1 character(s)`

**Cause:** `KILN_WORKOS_CLIENT_ID` is unset or still the placeholder `client_REPLACE_ME`.

**Fix:** set a real WorkOS client ID before deploy. Redeploy — env var changes require a Lambda update. See [`workos-setup.md`](./workos-setup.md).

### `Task timed out after 540.00 seconds`

**Cause:** something hung without a timeout. kiln sets timeouts on every known external call (`src/config.ts` `timeouts`), so this shouldn't happen. If it does: Bedrock stream that failed to propagate its abort, or an `@octokit/rest` call without the wrapper.

**Fix:** find the stuck call in the worker log (last audit status before timeout is your clue). File a bug — any call without a deadline is a defect. Short-term: reduce `KILN_BEDROCK_TIMEOUT_MS` and retry.

### Worker logs `LEDGER_DESYNC — PR opened but ledger write failed after retries`

**Cause:** a PR was opened on GitHub but the DynamoDB write that records it failed three times in a row. The audit record carries the PR URL + `alert: "ledger-desync"` tag.

**Fix (urgent — same-day):** a retry of this message will open a duplicate PR.
```bash
# 1. Grab the PR URL + idempotency digest from the alert.
# 2. Hand-insert the ledger row:
aws dynamodb put-item --table-name kiln-pr-ledger --item "$(cat <<EOF
{
  "teamId": {"S": "<from alert>"},
  "idempotencyKey": {"S": "<digest from alert>"},
  "key": {"M": {...}},
  "pr": {"M": {"owner": {"S": "..."}, "repo": {"S": "..."}, "number": {"N": "..."}, "url": {"S": "..."}, "headSha": {"S": "..."}}},
  "openedAt": {"S": "..."}
}
EOF
)"

# 3. Drain the SQS message (it has dedup so it won't retry, but if 5 min has passed...):
aws sqs receive-message --queue-url $(aws sqs get-queue-url --queue-name kiln-upgrade-queue.fifo --query QueueUrl --output text)
# then delete-message with the ReceiptHandle.
```

Then investigate why DDB writes failed — almost always a throttle or a region-wide incident.

---

## DynamoDB errors

### `ValidationException: One or more parameter values were invalid: ... key element does not match the schema`

**Cause:** you're writing an item without the required sort key. `kiln-pr-ledger` and `kiln-audit-log` both have composite keys.

**Fix:** check the table's schema. `kiln-pr-ledger` needs `teamId` + `idempotencyKey`. `kiln-audit-log` needs `teamId` + `sk`.

### `ProvisionedThroughputExceededException`

**Cause:** all kiln tables are `PAY_PER_REQUEST`, so this isn't a provisioned-capacity issue — it's a partition hot-spot. Overwhelmingly the rate-limiter table, because every worker writes the same `bucketKey` pattern.

**Fix (short-term):** bump `KILN_GITHUB_RATE_REFILL_PER_SEC` to reduce conditional-write retries.

**Fix (structural):** shard the bucket key by team hash — planned for v1.1. Open a ticket referencing `src/adapters/dynamodb/rate-limiter.ts`.

### `ConditionalCheckFailedException` in PR ledger

**Cause:** two workers raced to open a PR for the same `(team, repo, pkg, from, to)` tuple. The FIFO `MessageDeduplicationId` + `messageGroupId` pair usually prevents this; if you see it, either (a) two messages were enqueued outside the dedup window (5 min), or (b) you're hand-triggering.

**This is not a bug** — it's kiln's idempotency working. The losing worker returns `{kind: "skipped", message: "duplicate"}`. Nothing to fix.

---

## SQS + idempotency

### Duplicate PRs opened for the same upgrade

**Cause:** one of:
1. The idempotency digest changed between runs — `fromVersion` or `toVersion` differ. Check the PR descriptions.
2. The ledger write failed (see `LEDGER_DESYNC` above).
3. `MessageDeduplicationId` wasn't set on enqueue — check `src/adapters/sqs/queue.ts`. It should derive from `idempotencyDigest(key)`.

**Fix:** close the duplicate, correct the upstream bug. If this happens more than once: open a bug — kiln's core invariant (ADR 0004) is that duplicates are impossible.

### SQS DLQ depth > 0

**Cause:** an upgrade job failed `maxReceiveCount` (3) times.

**Fix:** see [`runbook.md`](./runbook.md) § "`kiln-upgrade-dlq-depth` fires".

### Messages stuck `InFlight` long after the worker finished

**Cause:** worker Lambda `visibilityTimeout` (10 min in CDK) is longer than the actual work took, and something prevented `DeleteMessage`. Usually a Lambda that died mid-execution (OOM, hard timeout).

**Fix:** increase Lambda memory (1024 MB → 2048 MB), or investigate why memory spiked. Check CloudWatch `MemoryUsed` metric on the worker function.

---

## Bedrock

### `AccessDeniedException: You don't have access to the model with the specified model ID`

**Cause:** Bedrock model access wasn't enabled in-console for this account/region. Claude Haiku 4.5 / Sonnet 4.6 / Opus 4.6 each require explicit model-access grants.

**Fix:** Bedrock console → Model access → Manage model access → check all three for both `us-west-2` AND `us-east-1`. Submit access request; usually instant but can take an hour.

### `ValidationException: The model ID is invalid for on-demand throughput`

**Cause:** Claude 4.x models require a cross-region inference profile — you can't invoke them with just the bare model ID in some regions.

**Fix:** use the inference profile ARN form:
```
arn:aws:bedrock:us-west-2:<account>:inference-profile/us.anthropic.claude-sonnet-4-6-v1:0
```
Update `KILN_BEDROCK_SYNTHESIZER_MODEL` (and classifier/escalation equivalents). The CDK stack's IAM policy must grant `bedrock:InvokeModel` on the inference profile ARN in addition to the foundation model.

### `ThrottlingException` from Bedrock under load

**Cause:** account-wide model TPS limit. Default is low; request a quota increase via Service Quotas.

**Fix:**
```bash
aws service-quotas request-service-quota-increase \
  --service-code bedrock \
  --quota-code <code-for-your-model> \
  --desired-value <higher>
```
Short-term: kiln's rate limiter will retry via SQS visibility timeout. Longer-term: route some traffic to `us-east-1` via the inference profile.

### Bedrock response parses but the pipeline logs `classify guardrail rejected output`

**Cause:** Haiku returned JSON that didn't match the zod schema in `src/core/ai/guardrails.ts`. Usually: missing field, wrong severity enum, hallucinated `changelogUrl`.

**Fix:** find the raw response in the worker log (captured at debug level only). If it's a repeat pattern, tighten the prompt in `src/core/ai/prompts.ts`. The evals suite (`tests/evals/classifier.eval.test.ts`) exists for this.

---

## GitHub App

### `HttpError: Bad credentials` when minting installation token

**Cause:** PEM is corrupted (CRLF, base64-wrapped, truncated) or the App ID doesn't match the PEM.

**Fix:** regenerate PEM, re-seed Secrets Manager, confirm App ID env var matches. See [`github-app-setup.md`](./github-app-setup.md) § "Verify".

### `404 Not Found` on `createOrUpdateFileContents`

**Cause:** the App isn't installed on the target repo, OR the repo permissions don't include `contents: write`, OR the branch doesn't exist.

**Fix:**
1. Confirm installation: visit `https://github.com/<org>/<repo>/settings/installations` — kiln should be listed.
2. If installed but `repos` is scoped to `selected` and this repo isn't included, add it.
3. Confirm App permissions (App settings → Permissions & events) include Contents = Read & write, Pull requests = Read & write.

### `403 Resource not accessible by integration`

**Cause:** mismatch between what your App permissions *claim* and what the installation token has. After granting new permissions, the installation must accept them.

**Fix:** installation URL on the App settings page → Accept new permissions. Then re-mint the token (Lambda cache expires in 50 min).

### Kiln opens a PR with empty patches

**Cause:** Sonnet decided no call sites needed rewriting, OR the code search returned no hits. Possible reasons:
- Breaking change affected symbols not actually imported by the target repo.
- Code search hit GitHub's per-App rate limit (30 req/min for search).

**Fix:** this is "working as intended" when there really are no call sites. If it's a search-rate-limit issue, the worker log will show `github:search 403 rate limited` — adjust the DDB token bucket refill rate.

---

## WorkOS / JWT

### API returns `401 unauthorized` on every request

**Cause:** one of:
1. Bearer token is missing or malformed.
2. Issuer or audience (clientId) mismatch between token and Lambda env.
3. JWKS fetch timed out / rejected (Lambda can't reach `api.workos.com`).
4. Token expired.

**Fix:**
```bash
# Decode the token (without verifying):
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .

# Check iss/aud match:
#   iss should equal KILN_WORKOS_ISSUER   (typically https://api.workos.com)
#   aud should equal KILN_WORKOS_CLIENT_ID (or be an array containing it)

# Check exp hasn't passed (Unix timestamp).
```

### `403 forbidden — teamId mismatch`

**Cause:** the `teamId` in the JWT claim doesn't match the `:teamId` in the URL path. By design — a caller cannot query another tenant's data. See `src/api/middleware/tenant-scope.ts`.

**Fix:** the caller is wrong (either the claim or the URL). This is not a bug; it's isolation enforcement.

### Lambda logs `missing or non-string claim "kiln_team_id"`

**Cause:** JWT doesn't carry the expected claim name, or the claim isn't a string.

**Fix:** check WorkOS Custom Claims config. The default claim name is `kiln_team_id`; customize via `KILN_WORKOS_TEAM_CLAIM`. In the WorkOS dashboard the claim value must be a string (not an array or object). See [`workos-setup.md`](./workos-setup.md) step 2.

### Lambda fails with `ENOTFOUND api.workos.com` or `fetch failed` on JWKS

**Cause:** outbound HTTPS egress to WorkOS is blocked. Fresh VPC deployments often hit this.

**Fix:** confirm Lambdas can reach `https://api.workos.com` (they need it for JWKS). If you deployed Lambdas inside a VPC, add a NAT gateway route or loosen the egress security group.

---

## Telemetry / Grafana Cloud

### `OTel init failed; continuing without telemetry` in Lambda logs

**Cause:** the init path ran but something went wrong. Best-effort — the Lambda keeps processing; you just don't get traces/metrics/logs for this invocation.

**Fix:** look in the log line for the specific error. Common causes:
- `OTLP auth secret has no string value` — the Secrets Manager secret is binary or empty. Re-seed.
- `OTLP auth secret is missing a string 'basic_auth' field` — the secret JSON is malformed. Ensure `{ instance_id, api_token }` are both set; the seeder auto-computes `basic_auth`.
- `AccessDeniedException: GetSecretValue` — the Lambda role can't read the OTLP secret. Check that `worker-construct.ts` / `poller-construct.ts` / `api-construct.ts` include the Grafana Cloud secret ARN in the `secretsmanager:GetSecretValue` resource list, then redeploy.

### No data in Grafana Cloud even though init succeeded

**Cause:** one of:
1. Wrong `OTEL_EXPORTER_OTLP_ENDPOINT` (typo, wrong region).
2. API token expired / revoked.
3. `KILN_TELEMETRY_ENABLED=false` in Lambda env (check `aws lambda get-function-configuration`).
4. Metrics use a periodic exporter — wait up to `OTEL_METRIC_EXPORT_INTERVAL` ms (default 60000).

**Fix:** verify via a curl against the OTLP gateway:
```bash
curl -v -X POST \
  -H "Authorization: Basic $(echo -n <instance>:<token> | base64)" \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[]}' \
  "$OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces"
# Expected: 200. If 401/403, rotate the token.
```

### Traces appear but have no `kiln.*` custom spans

**Cause:** auto-instrumentation fires on http/fetch/aws-sdk but manual `withSpan` wrappers run only when the code path executes. If you haven't exercised the pipeline yet, only the poller cycle span shows up.

**Fix:** fire a drill (`docs/drills.md` § 1) to run the full upgrader pipeline; `kiln.classify`, `kiln.synthesize`, `kiln.pr_open` spans should then appear.

### `OTel SDK started` log is missing on Lambda cold start

**Cause:** `KILN_TELEMETRY_ENABLED` is not literal `true` (zod coerces truthy values but it's case-sensitive to "true"/"1") OR `OTEL_EXPORTER_OTLP_ENDPOINT` / `KILN_GRAFANA_CLOUD_OTLP_SECRET_ARN` are unset.

**Fix:** check the actual Lambda env via `aws lambda get-function-configuration --function-name kiln-upgrader --query 'Environment.Variables'`. All three must be set to enable telemetry.

---

## Poller

### Poller runs but enqueues 0 jobs

**Cause:** either no teams configured, or no eligible upgrades.

**Fix:**
```bash
# Any teams at all?
aws dynamodb scan --table-name kiln-team-config --limit 5

# Is the poller seeing them?
aws logs tail /aws/lambda/kiln-poller --since 1h --filter-pattern '"teamsScanned"'
# Expected: teamsScanned matches your row count.

# Are watched deps already at latest?
# See `src/workers/poller.ts` — currentVersion is stubbed to "0.0.0" in v1, so
# any published version should be eligible under policy "latest".
```

If teams > 0 and enqueued = 0, check `targetVersionPolicy` on the team. `patch-only` + `minor-only` skip major bumps.

### Poller times out after 5 min

**Cause:** team count × watched deps × npm RTT exceeds 5 min. v1 polls sequentially.

**Fix:** short-term — shorten `watchedDeps` per repo. Long-term — parallelize npm fetches in `src/workers/poller.ts` (future work, deliberately skipped for v1 simplicity).

---

## Drill-specific gotchas

### Drill opens a PR but Slack alarm doesn't fire

**Cause:** SNS subscription isn't confirmed, or the SNS → Slack webhook URL is wrong.

**Fix:**
```bash
aws sns list-subscriptions-by-topic \
  --topic-arn $(aws sns list-topics --query 'Topics[?ends_with(TopicArn, `:kiln-alarms`)].TopicArn' --output text)
# "PendingConfirmation" means the email wasn't clicked yet.
```

### Drill PR opens but has no migration notes

**Cause:** the changelog fetcher couldn't retrieve the changelog (404 or SSRF-blocked URL). Check adapter log for `fetch failed 404` or `host not in allowlist`.

**Fix:** not every npm package hosts a markdown CHANGELOG at `raw.githubusercontent.com/<org>/<repo>/HEAD/CHANGELOG.md`. For packages that don't, Kiln v1 falls back to classifying on an empty changelog body — which produces empty breaking-change lists. Expected behavior; future work could try GitHub Releases endpoint.

### Drill runs clean but the integration test `cross-tenant-isolation` fails locally

**Cause:** DynamoDB Local container is reusing state from a prior run.

**Fix:** `testcontainers` should start fresh per run, but if you're running against a manually-started `amazon/dynamodb-local`, delete the tables:
```bash
aws dynamodb delete-table --endpoint-url http://localhost:8000 --table-name kiln-pr-ledger
# (etc for each table)
```
Then re-run.
