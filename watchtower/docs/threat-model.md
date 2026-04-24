# watchtower — threat model

STRIDE threat model for the watchtower subsystem. Living document — update as adopters fork for new clients.

## System boundary

Watchtower runs as a single ECS Fargate task in a private subnet with no ingress from the public internet (no ALB). Egress endpoints:

- Regulator feeds (HTTPS GET): SEC EDGAR, CFPB, OFAC, EDPB
- AWS service APIs: DynamoDB, SQS, S3, KMS, Secrets Manager, Bedrock
- pgvector database (private, VPC-local)
- Outbound notification endpoints: Slack webhook, Resend API
- Outbound publish endpoints: Notion API, Confluence API

Inputs: EventBridge Scheduler messages on the crawl queue + regulator feed responses.

Outputs: audit events (SQS → Lambda → DDB + S3), notifications (Slack + email), published memos (Notion / Confluence).

## STRIDE

### Spoofing

| Threat                                                                    | Mitigation                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attacker publishes a forged regulator feed that claims to be from the SEC | Feeds are fetched over HTTPS with certificate validation. Feed identity is pinned by URL (`sources.ts`); an attacker would need to compromise the regulator's HTTPS origin or DNS.                                           |
| Attacker forges an SQS message claiming to be from EventBridge Scheduler  | SQS queues have IAM-restricted send permissions. Only the scheduler's IAM role can enqueue to the crawl queue. Messages are validated with Zod; malformed payloads fail at the handler boundary.                             |
| Attacker triggers a publish job for a memo they didn't approve            | The approval gate reads memo state from DDB with `ConsistentRead`; unapproved memos throw `ApprovalRequiredError` before hitting the publisher. A CI grep-gate (`watchtower-ci.yml`) ensures no code path bypasses the gate. |

### Tampering

| Threat                                                       | Mitigation                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-flight SQS message modified between producer and consumer | SQS messages traverse TLS-only (AWS internal + HTTPS API). Integrity is implicit; IAM controls who can send / receive.                                                                                                                                |
| Audit records modified after emission                        | Audit events go through the FIFO queue → Lambda → DDB (with PITR on prod) + S3 (versioned per ArchiveBucket config). DDB-side modifications require IAM write permission on the audit table; least-privilege IAM grants only `PutItem` to the Lambda. |
| pgvector corpus tampering                                    | RDS is private to the VPC; no public endpoint. Only the ECS task's security group has ingress. Schema bootstrap uses `CREATE TABLE IF NOT EXISTS` — no DROP/ALTER in the app.                                                                         |
| Classifier rationale tampered to flip disposition            | The rationale is the LLM's own output; no post-processing other than Zod validation. Thresholds are env-driven, not embedded in the prompt.                                                                                                           |

### Repudiation

| Threat                                     | Mitigation                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator claims they didn't approve a memo | `MEMO_APPROVED` audit event records operator identity in the `approvedBy` field and is replicated to S3 archive (immutable once written, versioned). DDB PITR retains 35 days of history. |
| Publisher denies a page was created        | `MEMO_PUBLISHED` audit event captures `publishedPageId` + `destination` + timestamp. Notion/Confluence server-side logs provide a second record.                                          |
| Operator denies seeing an alert            | `ALERT_SENT` audit emits one event per successful channel with the recipient. Slack/email provider logs form a second record.                                                             |

### Information Disclosure

| Threat                                                                       | Mitigation                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bedrock invocation logs leak rule content / client names to CloudWatch or S3 | `BedrockLoggingDisabled` CDK construct asserts `DeleteModelInvocationLoggingConfiguration` at every deploy. Account-level setting; survives Bedrock console tampering via the next deploy.                                                                                                                                      |
| Per-client sensitive data in memo bodies leaks to general audit S3 access    | The memos DDB table uses a customer-managed KMS envelope key. Audit archive S3 is SSE-S3 by default — client rationales in audit events are truncated; full memo body only goes to DDB + the client's own destination KB.                                                                                                       |
| Slack webhook URL in code / logs                                             | Per-client Slack URLs live in the client's `ClientConfig.notifications.slackWebhookUrl` in DDB (KMS-encrypted at rest via the envelope key when CUSTOMER_MANAGED is enabled on clients table). A global fallback webhook comes from Secrets Manager, referenced via `ecs.Secret.fromSecretsManager` — never baked in plaintext. |
| OAuth secrets leak via env var inspection                                    | Secrets come from Secrets Manager via `ecs.Secret.fromSecretsManager` — delivered to the task at start, not visible in `aws ecs describe-task-definition`. A CI grep-gate rejects `cdk.SecretValue.secretsManager(…).unsafeUnwrap()`.                                                                                           |
| Classifier prompt contains PII that reaches Bedrock                          | Rule changes are public documents; client configs contain names and jurisdictions, not PII. `docs/integrations.md` documents the data flow. No end-user data reaches Bedrock in watchtower.                                                                                                                                     |

### Denial of Service

| Threat                                                     | Mitigation                                                                                                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regulator feed returns slow or never                       | Per-source circuit breaker (`src/crawlers/http.ts`) opens after 5 consecutive failures; subsequent calls short-circuit for 30s before a half-open probe. `AbortSignal.timeout(10s)` caps each call.       |
| Classifier invoked for a client that doesn't exist anymore | `classify` handler fetches the client with `clients.get`; if inactive / missing, the job drops quietly.                                                                                                   |
| Publish queue spammed with approval-less messages          | The approval gate rejects non-approved memos at Phase 1 before hitting the external API. Soft-ack keeps the DLQ clean.                                                                                    |
| SQS throttles the consumer                                 | Consumer wraps `provider.dequeue()` in a circuit breaker (`src/consumer/handler.ts`); breaker trips sleep the poll loop rather than hammer the queue.                                                     |
| Runaway cost from Bedrock calls                            | Concurrency is bounded per stage (`CLASSIFY_CONCURRENCY`, `PUBLISH_CONCURRENCY` — default 5 and 2 respectively). CloudWatch alarms on stage queue DLQ depth surface stuck handlers before retries spiral. |

### Elevation of Privilege

| Threat                                                                                               | Mitigation                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ECS task role over-granted and exfiltrates other account data                                        | Task role is scoped via CDK `grant*` calls on specific tables / queues / KMS key / Bedrock model ARNs. No `*` resources except for `cloudwatch:PutMetricData` which is condition-scoped to the `Watchtower` namespace.                                                                                                                                  |
| Classifier prompt injection makes the LLM return a crafted JSON that bypasses disposition thresholds | The LLM's response is re-validated with Zod AND thresholds are applied server-side in `classifier.ts` — the LLM can't claim disposition, only score. Prompt injection that pushes a score above threshold still passes through the approval gate (which doesn't trust the classifier for publish — it trusts the operator flipping `status: approved`). |
| Memo body injection attacks the downstream Notion / Confluence receiver                              | Markdown-to-Notion-blocks / Confluence-storage converters are narrow (paragraphs + headings + bullets); no HTML pass-through, no Confluence macros. Escape HTML characters in Confluence storage format.                                                                                                                                                |
| An unauthorized operator approves a memo                                                             | Memo approval transitions happen via an external surface (CLI / HTTP endpoint — out of scope for v0 baseline). The gate only trusts DDB state; auth for the approval UI is client-implementation-specific.                                                                                                                                              |

## Abuse scenarios

1. **Malicious insider approves a memo with fabricated content.** Memo body is drafted by an LLM; operator reviews + approves. The audit trail (`MEMO_DRAFTED` → `MEMO_APPROVED` → `MEMO_PUBLISHED`) captures the approver identity and timestamps. Mitigation depends on the approval UI's identity story; watchtower's responsibility is end-to-end audit capture.

2. **Compromised regulator feed injects a high-urgency fake rule change.** Classifier scores it against real client configs; a true positive still triggers review. No direct publish — human approval required. Audit trail captures the source URL + contentHash so a forensic re-scrape confirms the feed state at ingest time.

3. **Publisher OAuth token rotated mid-publish.** Publisher throws `HTTP 401`. Gate catches, emits `MEMO_PUBLISH_BLOCKED`, throws to SQS DLQ (no silent failure). Operator rotates the token via Secrets Manager, redeploys, and the stuck memo is manually re-queued.

## Not in this threat model (in-scope for a follow-up)

- Operator approval surface — v0 leaves this client-specific.
- Per-user OAuth delegation for Notion / Confluence (`module-oauth-delegation` integration).
- WAF / rate limiting on any future HTTP ingress (none today).
