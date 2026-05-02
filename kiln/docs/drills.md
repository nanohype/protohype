# Drills

"How do I see kiln work without waiting 15 minutes?" Five strategies from cheapest to most complete. Run drill 1 and drill 3 on every staging deploy; drill 5 is a quarterly live-fire exercise.

## Where to look

When a drill is running, these are the five surfaces that show state:

| Where | What it shows | Command |
|---|---|---|
| CloudWatch log group `/aws/lambda/kiln-poller` | Per-cycle `teamsScanned`, `depsChecked`, `enqueued`, `skipped`, `errors` metrics | `aws logs tail /aws/lambda/kiln-poller --follow` |
| CloudWatch log group `/aws/lambda/kiln-upgrader` | Full pipeline trace per upgrade: classifying → scanning → synthesizing → pr-opened | `aws logs tail /aws/lambda/kiln-upgrader --follow` |
| DynamoDB `kiln-audit-log` | Every pipeline stage transition with timestamps; `ledger-desync` alerts | `aws dynamodb query --table-name kiln-audit-log --key-condition-expression 'teamId=:t' --expression-attribute-values '{":t":{"S":"team-smoke"}}'` |
| DynamoDB `kiln-pr-ledger` | Idempotency state — proves kiln isn't opening duplicates | Same pattern, table `kiln-pr-ledger` |
| SQS queue attrs | Depth, in-flight, DLQ | `aws sqs get-queue-attributes --queue-url ... --attribute-names All` |
| GitHub | The actual PR + branch + commits | Browser / `gh pr list` |

## Strategies (cheapest → most complete)

### 1. Manual poller invocation (60 seconds)

Tests: poller → SQS enqueue → worker → full pipeline → PR.

```bash
aws lambda invoke --function-name kiln-poller /tmp/out.json && cat /tmp/out.json
# {"teamsScanned":1,"depsChecked":1,"enqueued":1,"skipped":0,"errors":0}

# Wait ~30s, then:
aws dynamodb query --table-name kiln-audit-log \
  --key-condition-expression 'teamId=:t' \
  --expression-attribute-values '{":t":{"S":"team-smoke"}}' \
  --scan-index-forward false --limit 10 \
  | jq '.Items[].status.S'
# Expect: "pr-opened" at the top, preceded by "synthesizing", "scanning", "classifying", "pending"
```

Skips: scheduling behavior, cross-tenant isolation, rate-limiter behavior under concurrency.

### 2. Synthetic SQS message (3 minutes)

Tests: worker isolated from poller. Useful when you want to exercise the upgrader without burning npm API calls.

```bash
export TEAM=team-smoke
export DIGEST=$(echo -n "team-smoke|acme/test-repo|react|18.0.0|19.0.0" | sha256sum | awk '{print $1}')

aws sqs send-message \
  --queue-url $(aws sqs get-queue-url --queue-name kiln-upgrade-queue.fifo --query QueueUrl --output text) \
  --message-body '{
    "teamId":"team-smoke",
    "upgradeId":"drill-'$(date +%s)'",
    "repo":{"owner":"acme","name":"test-repo","installationId":12345678},
    "pkg":"react",
    "fromVersion":"18.0.0",
    "toVersion":"19.0.0",
    "enqueuedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "groupKey":"team-smoke:acme/test-repo:react"
  }' \
  --message-group-id "team-smoke:acme/test-repo:react" \
  --message-deduplication-id "$DIGEST"
```

Watch `/aws/lambda/kiln-upgrader`. Full pipeline should complete in 30–90s depending on Bedrock latency.

### 3. Idempotency drill (2 minutes)

Proves duplicate submission ≠ duplicate PR. Re-send the same SQS message.

```bash
# Send it once.
./scripts/fire-drill.sh --pkg react --from 18.0.0 --to 19.0.0
sleep 60

# Send it AGAIN with the same inputs.
./scripts/fire-drill.sh --pkg react --from 18.0.0 --to 19.0.0

# The second message should either:
#  a) be dedup'd by FIFO (within the 5-min window), OR
#  b) hit the ledger check in the worker and return {kind:"skipped", message:"duplicate"}.
aws logs filter-log-events \
  --log-group-name /aws/lambda/kiln-upgrader \
  --filter-pattern '"PR already opened"' \
  --start-time $(date -d '5 minutes ago' +%s000)
# Expect: one hit.
```

Exactly one PR should exist on the test repo.

### 4. Cross-tenant isolation drill (5 minutes)

Run locally against DynamoDB Local. Same test that runs in CI, but explicit.

```bash
npm run test:integration -- tests/integration/cross-tenant-isolation.test.ts
# Expect: all pass.
```

Then hand-verify against real AWS:

```bash
# As team A (via WorkOS JWT), list team A's upgrades — should succeed.
curl -H "Authorization: Bearer $TEAM_A_TOKEN" \
  https://<api-url>/teams/team-a/upgrades

# As team A, try to list team B's upgrades — should 403.
curl -H "Authorization: Bearer $TEAM_A_TOKEN" \
  https://<api-url>/teams/team-b/upgrades
# Expected: {"error":"forbidden","detail":"teamId mismatch"}
```

### 5. Live-fire end-to-end (30 minutes, quarterly)

The real thing against a real fixture repo.

**Setup (one-time):**
1. Create a private sandbox repo: `acme/kiln-sandbox`.
2. Commit a `package.json` that pins an older version of a flagship dep (e.g., `react@18.2.0`).
3. Install the kiln staging GitHub App on it.
4. Add a team row in `kiln-team-config` pointing at the sandbox repo.

**Drill:**
1. `aws lambda invoke --function-name kiln-poller /tmp/out.json`
2. Watch the worker log for 60s.
3. On GitHub: a `kiln/react-19.0.0` branch and PR should appear.
4. **Read the PR** — migration notes should cite the real changelog, patches should touch actual `react` import sites.
5. Close the PR. Delete the branch. Delete the PR ledger row (so the drill repeats next quarter).

```bash
# Reset the ledger:
DIGEST=$(echo -n "team-sandbox|acme/kiln-sandbox|react|18.2.0|19.0.0" | sha256sum | awk '{print $1}')
aws dynamodb delete-item --table-name kiln-pr-ledger \
  --key "{\"teamId\":{\"S\":\"team-sandbox\"},\"idempotencyKey\":{\"S\":\"$DIGEST\"}}"
```

## Common drill gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `fire-drill.sh` returns but worker log is silent | FIFO dedup collapsed the message (same `MessageDeduplicationId` within 5 min) | Wait 5 min or change one of the inputs (e.g., bump `toVersion`) |
| Drill opens a PR with no patches | Sonnet found no call sites of affected symbols in the target repo | Expected on sandbox repos with trivial content. Add a real import of the affected symbol to get a patch |
| Drill 5 opens a duplicate PR | Ledger was manually cleared but GitHub branch still exists | Delete the branch + the GitHub PR before rerunning |
| Alarm fires but nobody gets notified | SNS subscription not confirmed, or no subscription at all | `aws sns list-subscriptions-by-topic --topic-arn <kiln-alarms>` |
| Worker takes >5 min to process a drill message | Bedrock throttling | Look for `ThrottlingException` in the log; see [`troubleshooting.md`](./troubleshooting.md) § Bedrock |

## Minimal happy-path drill (5-step copy-paste)

For a staging smoke after every deploy:

```bash
# 1. Confirm health.
curl -s https://<api-url>/healthz | jq .

# 2. Trigger poller.
aws lambda invoke --function-name kiln-poller /tmp/out.json
cat /tmp/out.json

# 3. Watch worker for 60s.
timeout 60 aws logs tail /aws/lambda/kiln-upgrader --follow || true

# 4. Confirm PR created.
gh pr list --repo acme/test-repo --state open --label kiln

# 5. Confirm audit ledger shows pr-opened.
aws dynamodb query --table-name kiln-audit-log \
  --key-condition-expression 'teamId=:t' \
  --expression-attribute-values '{":t":{"S":"team-smoke"}}' \
  --scan-index-forward false --limit 1 \
  | jq '.Items[0].status.S'
# Expected: "pr-opened"
```

All five in <2 minutes. Run it after every `cdk:deploy`.

## CI drill

`.github/workflows/ci.yml` runs unit + integration on every PR. Nightly, `.github/workflows/evals.yml` runs the Bedrock eval harness (gated by `KILN_RUN_EVALS=1`) against a dedicated eval role. Neither fires a real SQS message or opens a real PR — that's the job of the post-deploy `npm run drill:staging` you run manually.

Drills that push messages into staging SQS should NOT run on every PR. That's live load against real AWS. The drill harness exists for post-deploy operator confidence, not CI regression.
