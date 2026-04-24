# watchtower — integrations

Every third-party dependency with its setup, env vars, and verification command. Fork-checklist for a new client: tick each row before a deploy.

## AWS Bedrock (classifier + memo drafter + embeddings)

- **What for:** applicability scoring (Claude Sonnet 4.6), memo drafting (Claude Sonnet 4.6), rule-change embeddings (Titan Text v2).
- **Auth:** task role policy `bedrock:InvokeModel` on specific ARNs (see `infra/lib/watchtower-stack.ts`).
- **Env:** `CLASSIFIER_MODEL_ID`, `MEMO_MODEL_ID`, `EMBEDDING_MODEL_ID`, `BEDROCK_REGION` (falls back to `AWS_REGION`), `BEDROCK_TIMEOUT_MS`.
- **Posture:** `BedrockLoggingDisabled` CDK construct asserts invocation logging is off at every deploy. Account-level setting.
- **Verify:** `aws bedrock-runtime invoke-model --model-id "$CLASSIFIER_MODEL_ID" --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":8,"messages":[{"role":"user","content":"ping"}]}' out.bin && cat out.bin`

## AWS DynamoDB (clients config + dedup + memos + audit hot)

- **What for:** four tables — `CLIENTS_TABLE` (per-client config), `DEDUP_TABLE` (`(sourceId, contentHash)` keyed), `MEMOS_TABLE` (`(memoId, clientId)` with `byStatus` GSI, CUSTOMER_MANAGED KMS encryption), `AUDIT_TABLE` (90d TTL hot copy).
- **Auth:** task role `grant*` calls in the CDK stack. Least-privilege: only the actions each code path needs (e.g. `clientsTable.grantReadData`, `memosTable.grantReadWriteData`).
- **Env:** `CLIENTS_TABLE`, `DEDUP_TABLE`, `MEMOS_TABLE`, `AUDIT_TABLE`, `ENVELOPE_KMS_KEY_ID`.
- **Verify:** `aws dynamodb describe-table --table-name "$CLIENTS_TABLE"`

## AWS SQS (stage handoff + audit)

- **What for:** four queues — crawl, classify, publish (standard), audit (FIFO). DLQ per queue with CloudWatch DLQ-depth alarm (from `SqsWithDlq` library construct).
- **Auth:** task role `grantSendMessages` + `grantConsumeMessages` on the three standard stage queues; `grantSendMessages` only on the audit FIFO queue (the Lambda consumer owns consumption).
- **Env:** `CRAWL_QUEUE_URL`, `CLASSIFY_QUEUE_URL`, `PUBLISH_QUEUE_URL`, `AUDIT_QUEUE_URL`.
- **Verify:** `aws sqs get-queue-attributes --queue-url "$CRAWL_QUEUE_URL" --attribute-names All`

## AWS S3 (audit archive)

- **What for:** long-term audit event archive via `ArchiveBucket` library construct. Intelligent-tiering after 90d, 1y expiration, block-public-access, versioning off (on the default — enable for legal-hold clients).
- **Auth:** the audit consumer Lambda has `s3:PutObject`; task role is not granted S3 directly.
- **Env:** `AUDIT_BUCKET` (for the Lambda environment).
- **Verify:** `aws s3 ls "s3://$AUDIT_BUCKET"`

## AWS KMS (envelope key)

- **What for:** customer-managed key for CUSTOMER_MANAGED encryption on the memos DDB table. Also available to adopters who want to envelope-encrypt per-client sensitive payloads at the app layer.
- **Auth:** task role `grantEncryptDecrypt`.
- **Env:** `ENVELOPE_KMS_KEY_ID` (arn or key id — used for the memos table DDB SSE).
- **Verify:** `aws kms describe-key --key-id "$ENVELOPE_KMS_KEY_ID"`

## AWS Secrets Manager

- **What for:** `watchtower/{env}/app-secrets` — OAuth client creds, Slack webhook, Resend key, STATE_SIGNING_SECRET. Seeded with placeholders on CREATE via the `AppSecrets` library construct; operators populate real values after first deploy, no code change required.
- **Auth:** `ecs.Secret.fromSecretsManager` grants per-key read access to the task.
- **Verify:** `aws secretsmanager get-secret-value --secret-id "watchtower/staging/app-secrets" --query SecretString --output text | jq 'keys'`

## pgvector (RDS Postgres)

- **What for:** rule corpus — title/url/body/metadata + 1024-dim Titan embeddings per chunk. Used by the indexer (hot path) and future retrieval passes.
- **Auth:** RDS master credentials from `PgvectorDatabase` construct — stored in Secrets Manager, injected to the task via `ecs.Secret.fromSecretsManager` on the `CORPUS_USER` / `CORPUS_PASSWORD` env vars. Private VPC endpoint only.
- **Env:** `CORPUS_HOST`, `CORPUS_PORT`, `CORPUS_DATABASE`, `CORPUS_USER`, `CORPUS_PASSWORD`.
- **Schema:** `src/pipeline/pgvector.ts` `ensureCorpusSchema()` creates `CREATE EXTENSION vector` + `rule_chunks` table + HNSW cosine index idempotently on app boot.
- **Verify:** `psql "$CORPUS_URL" -c "SELECT COUNT(*) FROM rule_chunks;"`

## Regulator feeds

- **SEC EDGAR:** `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&…` (Atom). SEC requires a specific User-Agent format identifying the organization. `http.ts` sends `watchtower/0.1.0 (…)` — update the User-Agent to include your contact email if the SEC's policy tightens.
- **CFPB:** `https://www.consumerfinance.gov/about-us/newsroom/feed/` (RSS).
- **OFAC:** `https://home.treasury.gov/system/files/126/sdn_advanced.xml` (structured XML).
- **EDPB:** `https://www.edpb.europa.eu/news/news_en.rss` (RSS).
- **Auth:** none — all feeds are public.
- **Verify:** `curl -A "watchtower/0.1.0" -I "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=&company=&dateb=&owner=include&count=40&output=atom"`

## Slack (per-client alerts)

- **What for:** incoming webhook per client or a global fallback for low-volume deploys. Block Kit payload composed in `src/notify/slack.ts`.
- **Auth:** webhook URL (bearer). Per-client URL in `ClientConfig.notifications.slackWebhookUrl`; global fallback via `SLACK_WEBHOOK_URL` env from Secrets Manager.
- **Verify:** `curl -X POST -H 'Content-Type: application/json' --data '{"text":"ping"}' "$SLACK_WEBHOOK_URL"`

## Resend (email alerts)

- **What for:** per-client email alerts via REST API (no SDK). Recipients from `ClientConfig.notifications.emailRecipients[]`.
- **Auth:** bearer API key from Secrets Manager → `RESEND_API_KEY`.
- **Env:** `RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL`.
- **Verify:** `curl -X POST -H "Authorization: Bearer $RESEND_API_KEY" -H "Content-Type: application/json" https://api.resend.com/emails -d '{"from":"watchtower@example.com","to":"test@example.com","subject":"ping","text":"ping"}'`

## Notion (memo publish)

- **What for:** destination #1 for approved memos. Creates one Notion page per memo under the client's configured database. Uses the Notion API v1 REST directly.
- **Auth:** bearer integration token per client (manual setup — the client installs the watchtower Notion integration into their workspace, scoped to the memo database). Token stored in `NOTION_OAUTH_CLIENT_SECRET` in Secrets Manager.
- **Env:** `NOTION_OAUTH_CLIENT_SECRET` (+ `NOTION_OAUTH_CLIENT_ID` reserved for a future OAuth-delegation variant).
- **Per-client config:** `ClientConfig.publish.notionDatabaseId`.
- **Verify:** `curl -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28" "https://api.notion.com/v1/databases/$DB_ID"`

## Confluence (memo publish — alternate)

- **What for:** destination #2 for approved memos. Same shape as Notion but against Confluence Cloud.
- **Auth:** basic auth (email + API token). Set at instantiation time in `src/publish/confluence.ts`; credentials from Secrets Manager.
- **Env:** `CONFLUENCE_OAUTH_CLIENT_ID`, `CONFLUENCE_OAUTH_CLIENT_SECRET` (naming is legacy — these are the email + token, not OAuth 2.0 creds; rename is a v2 task).
- **Per-client config:** `ClientConfig.publish.confluenceSpaceKey`.
- **Verify:** `curl -u "$EMAIL:$TOKEN" "https://$HOST/wiki/rest/api/space/$SPACE_KEY"`

## OpenTelemetry / ADOT

- **What for:** traces → X-Ray, metrics → CloudWatch EMF. ADOT collector runs as a sidecar on the Fargate task (from `OtelSidecar` library construct). App exports OTLP over gRPC to `localhost:4317`.
- **Auth:** task role has the ADOT-required IAM permissions (granted by the construct).
- **Env:** `OTEL_RESOURCE_ATTRIBUTES` (set by `initTelemetry` + sidecar).
- **Verify:** check X-Ray service map for `service.name=watchtower` after one crawl completes.
