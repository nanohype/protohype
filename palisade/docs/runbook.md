# palisade — operator runbook

## First-deploy checklist

1. Set region env: `export CDK_DEFAULT_REGION=us-west-2` (override as needed).
2. `cd infra && npm install`.
3. `npx cdk bootstrap` (first-time only, per account+region).
4. `npm run deploy` → `PalisadeStaging` by default. The ECS service will come up healthy against a placeholder `ADMIN_API_KEY` and `INTERNAL_SIGNING_SECRET`; the gate and proxy are reachable.
5. **Bootstrap pgvector schema** (CDK does not do this for you):
   ```sql
   -- Run once against the RDS instance output: `cd infra && npx cdk deploy --outputs-file outputs.json`
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE TABLE IF NOT EXISTS attack_corpus (
     corpus_id TEXT PRIMARY KEY,
     body_sha256 TEXT NOT NULL UNIQUE,
     prompt_text TEXT NOT NULL,
     embedding vector(1024) NOT NULL,
     taxonomy TEXT NOT NULL,
     label TEXT NOT NULL,
     approved_by TEXT NOT NULL,
     approved_at TIMESTAMPTZ NOT NULL,
     source_attempt_id TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS attack_corpus_embedding_idx
     ON attack_corpus USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
   ```
6. **Seed real app secrets:** `aws secretsmanager put-secret-value --secret-id palisade/staging/app-secrets --secret-string '{"ADMIN_API_KEY":"…","INTERNAL_SIGNING_SECRET":"…","OTEL_EXPORTER_OTLP_HEADERS":"…"}'`
7. **Force ECS rollout** so the task picks up the new secret values: `aws ecs update-service --cluster palisade-staging --service palisade-staging --force-new-deployment`.
8. Smoke:
   ```bash
   SERVICE_URL=$(aws cloudformation describe-stacks --stack-name PalisadeStaging \
     --query 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue' --output text)
   curl -f "$SERVICE_URL/health"
   ```

## Label-approval flow (reviewer playbook)

1. Triage queue: `aws dynamodb query --table-name palisade-label-queue-staging --index-name status-index --key-condition-expression '#s = :s' --expression-attribute-names '{"#s":"status"}' --expression-attribute-values '{":s":{"S":"PENDING_APPROVAL"}}'`
2. Review each draft's `promptText` and `taxonomy`. The proposer wrote both; reviewer confirms or rejects.
3. Approve:
   ```
   POST /admin/labels/:draftId/approve
   { "approverUserId": "reviewer-username" }
   ```
   Which triggers the two-phase commit: `LABEL_APPROVED` → verify → corpus insert → `CORPUS_WRITE_COMPLETED` → draft row flips to APPROVED.
4. If the proposed label is wrong or the prompt is benign, reject:
   ```
   POST /admin/labels/:draftId/reject
   { "rejectorUserId": "reviewer-username", "reason": "false positive — meta-discussion of jailbreak personas" }
   ```

## Incident: gate verification failed

Metric: `palisade.gate.verification_failed`.
Alarm: `GateVerificationFailedAlarm` in the CDK stack, evaluation period 1, threshold 1.

What it means: the gate wrote `LABEL_APPROVED` to the audit log, then the strongly-consistent follow-up query found zero matching events. Something is deeply wrong in DDB — either the write silently failed despite appearing to succeed, or the PK/SK schema has drifted.

Steps:

1. Check `aws dynamodb query` directly for the attempt_id — does the `LABEL_APPROVED` event exist?
2. If yes: investigate the `verifyApproval` query construction in `src/audit/audit-log.ts`.
3. If no: a DDB PutItem ConditionalCheckFailedException was swallowed incorrectly, or the table is throttling. Inspect CloudWatch `SuccessfulRequestLatency` on the audit table.

Until resolved: corpus writes are blocked (by design). The proxy + honeypot + rate limiter continue functioning.

## Incident: attack-log DLQ non-empty

Alarm: `AttackDlqDepthAlarm`.

What it means: the Lambda `attack-consumer` is failing to write a record to S3 — bucket policy drift, KMS key issue, or a malformed record. Inspect the Lambda CloudWatch logs.

Recovery:

1. Fix the root cause.
2. Replay the DLQ: `aws sqs start-message-move-task --source-arn <dlq-arn> --destination-arn <primary-arn>`

## Rotating the eval baseline

Baseline is in `eval/baseline.json`, checked in. To intentionally adjust (e.g. after a detection-layer improvement raises TPR):

1. `npm run eval:run` → updates `eval/results.json`.
2. Manually review the delta against the current baseline.
3. `npm run eval:baseline` → copies results to baseline.
4. Commit both `results.json` (for traceability) and `baseline.json` (the new floor) on a PR. Explain the delta in the commit message.

## Shutting down a staging environment

1. `cd infra && npx cdk destroy PalisadeStaging`.
2. Verify in the AWS console that the RDS instance + S3 bucket are gone (both use RETAIN in prod, DESTROY in staging).
3. If anything is stuck, check CloudFormation stack events for the failing resource.
