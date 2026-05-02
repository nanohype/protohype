# Secrets inventory + seeding + rotation

kiln holds credentials in AWS Secrets Manager. Values never transit CloudFormation, never land in env vars, and are cached in-process for ≤5 minutes so rotation reaches running Lambdas automatically.

## The secrets

Five per environment. Staging and production paths are fully disjoint; the staging Lambda role cannot read production secrets.

| Secret name | Type | Provenance | Rotation | Consumers |
|---|---|---|---|---|
| `kiln/{env}/github-app-private-key` | PEM string | Generate in the GitHub App settings → **Private keys** → Download | Quarterly | worker Lambda (installation-token minting) |
| `kiln/{env}/grafana-cloud/otlp-auth` | JSON `{ instance_id, api_token, basic_auth }` | Grafana Cloud → Access Policies → create write-scoped token. `basic_auth` is auto-computed by the seeder from `instance_id` + `api_token`. Required if `KILN_TELEMETRY_ENABLED=true`; unused otherwise | Annual | all three Lambdas at cold start (via `src/telemetry/init.ts`) |
| `kiln/{env}/workos/api-key` | string | WorkOS dashboard → API keys → Server Key. Optional — only if kiln calls the WorkOS Management API server-side (not used in v1) | Quarterly | api Lambda (currently unused; reserved) |
| `kiln/{env}/slack/webhook-url` | string | Slack → Incoming Webhooks → new URL scoped to the alert channel. Optional — alarms fire without it, but nobody gets pinged | Annual | worker Lambda + ops SNS subscription |
| `kiln/{env}/linear/api-key` | string | Linear → Settings → API → Personal API keys. Optional — only if Linear issue creation is enabled per team | Annual | worker Lambda |

Not secrets — but referenced in the same flow:

| Value | Where it lives | Why it's not a secret |
|---|---|---|
| GitHub App ID (numeric) | Lambda env (`KILN_GITHUB_APP_ID`) | Public per GitHub's model |
| WorkOS issuer URL (`https://api.workos.com`) | Lambda env (`KILN_WORKOS_ISSUER`) | Public; JWKS is at `${issuer}/sso/jwks/${clientId}` |
| WorkOS client ID (`client_XXXXXX`) | Lambda env (`KILN_WORKOS_CLIENT_ID`) | Public identifier; used as JWT audience |
| OTLP endpoint URL (`https://otlp-gateway-prod-...grafana.net/otlp`) | Lambda env (`OTEL_EXPORTER_OTLP_ENDPOINT`) | Public; the auth credential is separate |
| DynamoDB table names, SQS URL | **Set by CDK** — injected into Lambda env at deploy | Service-layer identifiers; assume AWS IAM is your perimeter |

## Seed all secrets in one shot

Use the JSON-driven seeder. Safer than hand-running AWS CLI: it validates the template, rejects placeholder values, and handles the PEM-from-file pattern without you having to remember `$(cat pem)`.

### 1. Copy the template

```bash
cp secrets.template.json kiln-secrets.staging.json
# Populated files are gitignored.
```

### 2. Fill in real values

Edit `kiln-secrets.staging.json`:

```json
{
  "github-app-private-key": "@file:/absolute/path/to/kiln-app-private-key.pem",
  "slack/webhook-url": "https://hooks.slack.com/services/T.../B.../...",
  "linear/api-key": null,
  "grafana-cloud/otlp-auth": { "instance_id": "123456", "api_token": "glc_YOUR_TOKEN" },
  "workos/api-key": null
}
```

Value conventions:

| Form | Meaning |
|---|---|
| `"..."` (plain string) | Raw value stored as `SecretString` |
| `{ ... }` (JSON object) | Serialized and stored as `SecretString` (e.g., `grafana-cloud/otlp-auth`). For OTLP auth specifically, the seeder auto-computes `basic_auth` from `instance_id` + `api_token` if omitted |
| `"@file:/abs/path"` | Contents of the file become the secret value (use for the PEM) |
| `null` | Skipped. Only allowed for optional keys |

### 3. Seed

```bash
# Dry-run first — no AWS calls, just prints what would happen.
npm run seed:staging:dry

# Live:
npm run seed:staging

# After a successful run, delete any @file: sources manually, OR pass --shred:
bash scripts/seed-secrets.sh --env staging --shred
```

The seeder is idempotent — re-running on an existing secret does a `put-secret-value` (new version) instead of failing. Safety rails:

- Any `REPLACE_ME` sentinel anywhere in the file → abort before any AWS call.
- Missing required keys → abort.
- Required key set to `null` → abort.
- Invalid JSON → abort.
- Never logs secret values; only key names + byte counts.

### Manual fallback

If you can't run the seeder (no jq, no bash, locked-down shell), the underlying CLI is:

```bash
ENV=staging
aws secretsmanager create-secret \
  --name "kiln/$ENV/github-app-private-key" \
  --description "GitHub App PEM for kiln-$ENV — rotate quarterly" \
  --secret-string "$(cat /path/to/kiln-app-private-key.pem)"

# Delete local copies.
shred -u /path/to/kiln-app-private-key.pem
```

## The CDK binding

`infra/lib/constructs/secrets-construct.ts` creates a single Secrets Manager secret for the GitHub App PEM with `RemovalPolicy.RETAIN`. Kiln's worker IAM role gets `secretsmanager:GetSecretValue` scoped to that one ARN — not `*`. Optional secrets (Slack, Linear) are referenced by ARN via env var; add an IAM statement per secret you actually seed.

The worker Lambda reads the PEM once per 5-minute window via `src/adapters/secrets-manager/client.ts` (module-scope cache). Rotation reaches running Lambdas within 5 minutes without redeploy.

## Rotate by hand

```bash
# 1. Generate new PEM in the GitHub App UI (two can coexist during rollover).
# 2. Upload:
aws secretsmanager put-secret-value \
  --secret-id "kiln/$ENV/github-app-private-key" \
  --secret-string "$(cat new.pem)"

# 3. Wait 6 minutes (one cache TTL + margin).
# 4. Revoke the old PEM in the GitHub App UI.
```

Do NOT use Secrets Manager's automatic rotation scheduler for the GitHub App PEM — rotation requires a human to click "Generate new private key" in the GitHub UI and GitHub does not expose an API for it.

## Rotation cadence

| Secret | Cadence | Triggers ad-hoc rotation |
|---|---|---|
| GitHub App PEM | Quarterly | Suspected leak; contractor/employee offboarding who had access; routine audit |
| Slack webhook | Annual | Workspace admin compromise; webhook URL accidentally committed |
| Linear API key | Annual | Linear account ownership change |
| Grafana Cloud OTLP token | Annual | Token compromise; rotating access-policy scopes |
| WorkOS API key (if present) | Quarterly | Admin access change; suspected leak |

## Verification

After any seed or rotation, run the three-point check:

```bash
# 1. Secret is present + parseable.
aws secretsmanager get-secret-value \
  --secret-id "kiln/$ENV/github-app-private-key" \
  --query SecretString --output text | head -1
# Expected: -----BEGIN RSA PRIVATE KEY-----  or  -----BEGIN PRIVATE KEY-----

# 2. Worker Lambda can read it (tails the latest log for the bootstrap line).
aws logs tail /aws/lambda/kiln-upgrader --since 5m \
  --filter-pattern '"could not load GitHub App secret"'
# Expected: no matches

# 3. App can mint a token.
npm run smoke:$ENV -- --check=github-app-token
# Expected: "minted installation token for <installationId>"
```

Fail-closed behavior: if Secrets Manager is unreachable at cold start, `composePorts` throws and the Lambda fails to initialize. CloudWatch will show `Runtime.ImportModuleError`. Fix: check the worker role's `secretsmanager:GetSecretValue` policy includes the ARN.

## Common trip-ups

| Symptom | Cause | Fix |
|---|---|---|
| `SerializationException` when reading Secrets Manager | Secret is binary, not `SecretString` | Re-seed with `--secret-string`, not `--secret-binary` |
| PEM parses but GitHub returns `Bad credentials` | CRLF line endings from a Windows copy/paste | `tr -d '\r' < in.pem > out.pem` then re-seed |
| Worker logs `AccessDenied: GetSecretValue` | IAM policy references wrong env's ARN, or secret created after deploy | Redeploy the stack (CDK regenerates the policy against the current ARN) |
| `ResourceNotFoundException` on first deploy | Stack expects the secret to already exist at deploy time | Seed before `cdk deploy`, not after |
| Rotation completed but old token still being used | 5-minute cache TTL hasn't expired | Wait 6 minutes, or force a Lambda redeploy to bust cold-start caches |
