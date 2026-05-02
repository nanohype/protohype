# kiln runbook

On-call reference. Every scenario below should map to an alarm in CloudWatch; if you got here without one firing, record a new alarm after the incident.

## Alarms → actions

### `kiln-upgrade-dlq-depth` fires (≥ 1 message in DLQ)

A job retried three times and failed. Symptoms:
- A team's PR hasn't opened.
- `/aws/lambda/kiln-upgrader` has error logs in the last hour.

Triage:
1. `aws sqs receive-message --queue-url $(aws sqs get-queue-url --queue-name kiln-upgrade-dlq.fifo --query QueueUrl --output text)` — read the body. It's an `UpgradeJob` JSON.
2. Search logs for `messageId` or `upgradeId`. The root cause is usually one of:
   - Bedrock throttle → check Bedrock throttling metric; consider bumping per-team rate bucket
   - GitHub 403 (rate limit) → check `kiln-rate-limiter` table for the team's bucket
   - LLM validation error (guardrails rejected output) → usually transient; replay
   - `ConditionalCheckFailedException` on PR ledger → the idempotency caught a duplicate; this is correct behavior, not a failure. The DLQ shouldn't actually receive these.

Replay:
```bash
# 1. Fix the underlying cause (e.g., rotate GitHub App secret, wait for Bedrock).
# 2. Move the message back:
scripts/dlq-replay.sh $MESSAGE_ID
```

### `kiln-bedrock-logging-drift` fires

**Critical.** Bedrock model invocation logging has been re-enabled in the kiln sub-account — customer source code may be flowing into CloudWatch or S3.

1. Immediately: disable it via CLI
   ```
   aws bedrock put-model-invocation-logging-configuration \
     --logging-config '{"textDataDeliveryEnabled": false}'
   ```
2. Identify who enabled it: CloudTrail search for `PutModelInvocationLoggingConfiguration`.
3. If any customer code already delivered: file a security incident, notify affected tenants, rotate GitHub App PEM + WorkOS API key + Grafana Cloud OTLP token.

### DynamoDB throttle

The adapters don't have retry-with-backoff built in (relies on SDK defaults). If you see `ProvisionedThroughputExceededException` in logs:
- All kiln tables are `PAY_PER_REQUEST` — throttle means a partition hot-spot, not quota. Most likely the rate-limiter table, because every worker writes the same `bucketKey`.
- Immediate mitigation: increase `KILN_GITHUB_RATE_REFILL_PER_SEC` to reduce conditional-write retries.
- Follow-up: shard bucket key by team hash.

## Rotations

### GitHub App private key (quarterly)

1. Generate new key in the GitHub App settings UI.
2. `aws secretsmanager put-secret-value --secret-id kiln/github-app-private-key --secret-string "$(cat new-key.pem)"`.
3. In-flight Lambda invocations keep the old key until their 5-min TTL expires. New invocations pick up the new key.
4. After 10 minutes, revoke the old key in the GitHub App UI.

### WorkOS issuer / clientId

Config change only. `KILN_WORKOS_ISSUER` and `KILN_WORKOS_CLIENT_ID` are Lambda env vars; `cdk deploy` propagates new values. No rolling restart needed. Signing-key rotation on the WorkOS side is transparent — `jose` refetches the JWKS on demand.

### Grafana Cloud OTLP token

1. Create new token under the same access policy (two tokens can coexist).
2. Update `kiln-secrets.{env}.json` → `grafana-cloud/otlp-auth.api_token`.
3. `npm run seed:{env}`.
4. Wait 6 minutes for the secrets-manager cache TTL to expire.
5. Revoke the old token in Grafana Cloud.

## Deploy failures

### `cdk deploy` fails with "resource has deletion protection"

Expected on `kiln-team-config`, `kiln-pr-ledger`, `kiln-audit-log`. If deleting intentionally: temporarily remove `deletionProtection: true` from the construct, deploy, then destroy. Do not keep the protection off.

### Bedrock model access denied

Bedrock models need to be enabled in the console per account per region. First deploy to a new sub-account: go to Bedrock → Model access → enable Claude Haiku 4.5, Sonnet 4.6, Opus 4.6 in both `us-west-2` and `us-east-1` (for cross-region failover).

## Testing in prod (safely)

1. Add a test team to `kiln-team-config` with `pinnedSkipList` containing everything except one throwaway package in a repo you own.
2. Wait for the next poll cycle (≤15 min) or invoke the poller Lambda directly.
3. Check `/aws/lambda/kiln-upgrader` for the pipeline trace.
4. Verify the PR in your repo.
5. Remove the test team.
