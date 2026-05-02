# Grafana Cloud setup

One-time walkthrough. Wires kiln's OTel traces + metrics + logs into Grafana Cloud. ~15 minutes. Telemetry is **opt-in** (`KILN_TELEMETRY_ENABLED=true`); kiln runs fine without it, falling back to CloudWatch Logs + CloudWatch alarms.

With this wired up, you get:
- **Tempo** — end-to-end traces across poller → SQS → worker, with per-stage spans (`kiln.classify`, `kiln.synthesize`, `kiln.pr_open`).
- **Mimir** — metrics like `kiln_upgrader_total_duration_ms{outcome}`, `kiln_pr_opened_count`, `kiln_bedrock_throttle_count`, `kiln_rate_limiter_reject_count`.
- **Loki** — structured logs with correlated `trace_id` + `span_id` so Tempo → Loki one-click jump works.

## Prerequisites

- A Grafana Cloud account (free tier is enough for staging).
- Admin access to the kiln AWS sub-account.
- kiln CDK stack already deployed OR you're about to deploy for the first time.

## 1. Create (or pick) a Grafana Cloud stack

1. Log into `https://grafana.com/profile/org`. If you have no stack yet, click **Create stack** and name it (e.g., `kiln-prod`).
2. Open the stack. The URL is your stack name.

## 2. Provision an access policy

kiln needs ONE API token with three scopes: `metrics:write`, `logs:write`, `traces:write`.

1. In Grafana Cloud, go to **Administration → Access Policies** (or the `/a/grafana-auth-app` page).
2. **Create access policy** named `kiln-{env}-otlp`.
3. Scopes: enable write on metrics, logs, and traces (and optionally read if you want the same token for dashboards/alerts provisioning).
4. Create a **token** under this policy named `kiln-{env}`. Copy the `glc_...` value — it's shown once.

## 3. Record the OTLP endpoint + instance ID

Grafana Cloud's OTLP gateway URL is region-specific. In the stack details, find:

- **OTLP endpoint** — e.g., `https://otlp-gateway-prod-us-west-0.grafana.net/otlp`
- **Instance ID** — the numeric ID shown in **Details → Prometheus** (it's the same ID used across Prometheus / Loki / Tempo for OTLP auth).

## 4. Seed the secret

The OTLP auth payload is a JSON object `{ instance_id, api_token }`; the seeder computes `basic_auth` automatically.

Edit your `kiln-secrets.staging.json`:

```json
{
  "github-app-private-key": "@file:/path/to/pem",
  "grafana-cloud/otlp-auth": {
    "instance_id": "123456",
    "api_token": "glc_YOUR_TOKEN_HERE"
  },
  "workos/api-key": null,
  "slack/webhook-url": null,
  "linear/api-key": null
}
```

Seed:

```bash
npm run seed:staging:dry     # preview
npm run seed:staging         # live
```

The seeder output should include:

```
[seed] grafana-cloud/otlp-auth: basic_auth auto-computed from instance_id + api_token
[seed] put/create: kiln/staging/grafana-cloud/otlp-auth (N bytes)
```

## 5. Enable telemetry in the kiln CDK env

```bash
export KILN_TELEMETRY_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-us-west-0.grafana.net/otlp
export OTEL_SERVICE_NAME=kiln
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=staging,service.version=0.1.0"

npm run cdk:deploy
```

The stack propagates these to all three Lambdas. Each Lambda fetches the `kiln/staging/grafana-cloud/otlp-auth` secret at cold start (in `src/telemetry/init.ts`) and constructs OTLP exporters with the `Authorization: Basic <base64>` header.

## 6. Verify

```bash
# Trigger the poller so a cold start fires.
aws lambda invoke --function-name kiln-poller /tmp/out.json

# Look for the init log line:
aws logs tail /aws/lambda/kiln-poller --since 2m \
  --filter-pattern '"OTel SDK started"'
# Expected: one line per cold start with service + endpoint.
```

In Grafana Cloud:
- **Explore → Tempo** → Service `kiln` → run. You should see a `kiln.poller.cycle` span tree within ~60s.
- **Explore → Mimir** → `{service_name="kiln"}` → you'll see `kiln_poller_cycle_duration_ms_*` histogram series.
- **Explore → Loki** → `{service_name="kiln"}` → structured logs with `trace_id` / `span_id` labels.

## 7. Import dashboards + alerts (optional, one-time)

Kiln ships baseline Grafana artifacts (TODO — `infra/dashboards/kiln.json` + `infra/alerts/kiln-rules.yaml` planned for v1.1). Until then, the raw metrics are useful as-is via Explore.

Recommended alerts to set up by hand:
- p99 `kiln_upgrader_total_duration_ms` > 5min (stuck pipeline)
- `rate(kiln_ledger_desync_count[5m]) > 0` (the critical one)
- `rate(kiln_bedrock_throttle_count[5m]) > 0.1` (throttle storm building)
- SQS DLQ depth ≥ 1 (CloudWatch alarm; see `infra/lib/constructs/observability-construct.ts`)

## Rotation

Grafana Cloud API tokens have no hard expiry but should be rotated annually.

1. **Create new token** under the same access policy (two active at once is allowed).
2. Update `kiln-secrets.staging.json` → `api_token`.
3. `npm run seed:staging` — overwrites the `grafana-cloud/otlp-auth` secret with the new value.
4. Wait 6 minutes (one `src/adapters/secrets-manager/client.ts` cache TTL + margin).
5. Revoke the old token in Grafana Cloud.

No Lambda redeploy needed — the secret rotates transparently through the module-scope cache.

## Disabling telemetry (rollback)

Set `KILN_TELEMETRY_ENABLED=false` and redeploy. The `initTelemetry` call becomes a no-op at cold start; logs still flow to CloudWatch via stderr, and CloudWatch alarms remain active.

## Common trip-ups

| Symptom | Cause | Fix |
|---|---|---|
| `OTel init failed; continuing without telemetry` in logs | Wrong `OTEL_EXPORTER_OTLP_ENDPOINT` or `KILN_GRAFANA_CLOUD_OTLP_SECRET_ARN`, or secret missing | Check the Lambda env and Secrets Manager entry — the init is best-effort so the Lambda keeps running |
| No data in Grafana Cloud after 5 minutes | Auth token expired/revoked, OR OTLP endpoint URL typo, OR `KILN_TELEMETRY_ENABLED=false` | Check for the `OTLP auth secret is missing a string 'basic_auth' field` error in Lambda logs |
| Traces appear but no metrics | Metrics use a periodic exporter (default 60s); wait 1-2 min | `OTEL_METRIC_EXPORT_INTERVAL` env var tunes this; shorter = more writes = higher cost |
| Logs appear in CloudWatch but not Loki | OTLP Logs require the `api-logs` SDK to be initialized; confirm `src/logger.ts` is emitting via the OTel logger (it does both sinks) | Check that telemetry init succeeded at cold start |
| `403 Forbidden` on OTLP requests | API token missing `write` scope | Rotate token with correct scopes |
