# watchtower — operator runbook

Response procedures for common operational incidents. Pair with the CloudWatch alarms on each stage queue's DLQ depth.

## Quick reference

| Signal                                         | Likely cause                                                    | First step                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Crawl DLQ depth ≥ 1                            | Regulator feed unreachable or parsing failed                    | `aws sqs receive-message --queue-url $CRAWL_DLQ_URL` — inspect body; check circuit breaker state in service logs |
| Classify DLQ depth ≥ 1                         | Bedrock quota / schema-invalid LLM response                     | Check recent `classifier LLM response failed schema` log lines; review model ID and prompt template              |
| Publish DLQ depth ≥ 1                          | Notion/Confluence API outage or auth rotated without redeploy   | `curl -I` the API; force `--force-new-deployment` on the ECS service to pick up rotated secret                   |
| Audit DLQ depth ≥ 1                            | Audit consumer Lambda failed (malformed event or DDB/S3 outage) | Check Lambda CloudWatch log group; redrive after fixing                                                          |
| `consumer-*` readiness check failing           | Consumer crashed / poll loop exited                             | Check service logs for panic; check circuit breaker state on the dequeue breaker                                 |
| Classifier returning all `review` dispositions | Model unavailable / credentials misconfigured                   | Check `failureMode` tag on recent audit events; verify Bedrock model access in the region                        |

## Incident: classify DLQ filling up

1. **Identify the cause.**
   ```sh
   aws logs tail /ecs/watchtower-staging --follow --filter-pattern 'classifier LLM' | head
   ```
   Look for `failureMode=timeout`, `failureMode=schema`, or `failureMode=llm-error`.
2. **If `timeout` dominates:** Bedrock may be throttled. Lower `CLASSIFY_CONCURRENCY` temporarily and redeploy.
3. **If `schema`:** the model's output shape changed. Check `src/classifier/classifier.ts` system prompt; LLM vendors occasionally adjust default behavior. The fail-secure path should catch these and route to review — but a lot of schema failures in a short window signals a deeper issue.
4. **If `llm-error`:** check Bedrock service health in the region. Confirm the task role has `bedrock:InvokeModel` on the configured model ID.
5. **Redrive the DLQ** once upstream is healthy:
   ```sh
   aws sqs start-message-move-task \
     --source-arn $CLASSIFY_DLQ_ARN \
     --destination-arn $CLASSIFY_QUEUE_ARN
   ```

## Incident: memo stuck in pending_review

Memos only publish after an operator transitions them to `approved`. If a memo has been sitting for > 24h, either:

- The operator approval surface is down / nobody's watching
- The memo is low-priority (classifier score was between review and auto-alert — expected behavior)

**To approve manually** (emergency operator workflow):

```sh
aws dynamodb update-item \
  --table-name $MEMOS_TABLE \
  --key '{"memoId": {"S": "<id>"}, "clientId": {"S": "<cid>"}}' \
  --update-expression "SET #s = :approved, approvedBy = :who, approvedAt = :ts, updatedAt = :ts" \
  --condition-expression "#s = :pending" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":approved": {"S": "approved"}, ":pending": {"S": "pending_review"}, ":who": {"S": "ops@example.com"}, ":ts": {"S": "'"$(date -u +%FT%TZ)"'"}}'
```

Then enqueue a publish job:

```sh
aws sqs send-message --queue-url $PUBLISH_QUEUE_URL \
  --message-body '{"memoId": "<id>", "clientId": "<cid>"}'
```

The publish handler will re-read memo state with ConsistentRead and proceed.

## Incident: duplicate alert sent to a client

Dedup is keyed on `(sourceId, contentHash)`. If a client saw the same alert twice:

1. **Check the crawl handler log for that contentHash:** it should show `alreadySeen: true` on the second crawl.
2. **If dedup was bypassed:** likely the content body changed between crawls (revised rule), producing a new hash. That's a correct dedup decision, not a bug — the client is seeing a revised version of the same change.
3. **If both emissions have the same hash:** the dedup DDB row was deleted or TTL'd unexpectedly. Dedup table has no TTL by default; check operator actions on the table.

## Incident: pgvector corpus indexing failures

Symptom: classify works but `indexer.indexRuleChange()` throws — logged by `crawl.ts` handler.

1. **Check pgvector extension is loaded:**
   ```sh
   psql "$CORPUS_URL" -c "SELECT extname, extversion FROM pg_extension WHERE extname='vector';"
   ```
   If missing: `ensureCorpusSchema` should have created it on boot. If it's not there, the task likely failed boot and is in a crash loop.
2. **Check embedding dimension matches the column:**
   ```sh
   psql "$CORPUS_URL" -c "SELECT atttypmod FROM pg_attribute WHERE attrelid = 'rule_chunks'::regclass AND attname='embedding';"
   ```
   `atttypmod` encodes the dimension. If you changed `EMBEDDING_MODEL_ID` to a model with a different dimension, you need to drop the column and re-run the migration — there's no online schema change for pgvector columns.

## Forcing a re-crawl

Send a scheduler-shaped message directly to the crawl queue:

```sh
aws sqs send-message --queue-url $CRAWL_QUEUE_URL \
  --message-body '{"source": "sec-edgar"}'
```

Dedup will filter out already-seen items. To re-classify a specific rule change across all clients, delete the dedup row for that `(sourceId, contentHash)` and re-send the crawl message.

## ECS Exec into a running task (staging only)

The CDK stack sets `enableExecute: !isProd` on the `WorkerService`. To shell into a staging task:

```sh
CLUSTER=$(aws cloudformation describe-stacks --stack-name WatchtowerStaging \
  --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue" --output text)
SERVICE=$(aws cloudformation describe-stacks --stack-name WatchtowerStaging \
  --query "Stacks[0].Outputs[?OutputKey=='ServiceName'].OutputValue" --output text)
TASK=$(aws ecs list-tasks --cluster $CLUSTER --service-name $SERVICE \
  --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster $CLUSTER --task $TASK \
  --container "Watchtower" --interactive --command "/bin/sh"
```

## Rotating secrets

App secrets (OAuth creds, Slack webhook, Resend key) live at `watchtower/{env}/app-secrets`. Rotate via `aws secretsmanager put-secret-value`, then force a new deployment so the task picks up the rotated value:

```sh
aws ecs update-service --cluster $CLUSTER --service $SERVICE --force-new-deployment
```

RDS master credentials rotate independently via Secrets Manager rotation schedule (set in the CDK stack). Rotation triggers a task redeployment automatically.

## Post-incident

Every incident should produce:

1. A Linear ticket linking to the alarm, the DLQ message(s) that exemplified the issue, and the fix.
2. An audit trail review — were `MEMO_PUBLISH_BLOCKED` events emitted? Were they acted on?
3. A classifier eval run if the incident was classification-related — re-score the labeled eval suite to confirm the fix didn't regress a client.
