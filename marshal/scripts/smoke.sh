#!/usr/bin/env bash
#
# Post-deploy smoke test for a Marshal CDK stack.
#
# Reads CFN outputs from the stack, waits for the ECS processor to reach
# steady state, then exercises the webhook ingress + verifies the DLQ is empty:
#   1. aws ecs wait services-stable   — processor is running after rollover
#   2. POST /webhook/grafana-oncall   — unsigned body, expect 401 (HMAC reject,
#                                       proves the handler is reachable and the
#                                       signature gate is live — anything 5xx
#                                       means the Lambda itself crashed)
#   3. Queue depth check              — incident + DLQ depth = 0 (system at rest)
#   4. Secrets presence check         — each of the 13 CDK-provisioned keys plus
#                                       the operator-provisioned OTLP auth secret
#                                       exists for this environment (not
#                                       validated for contents, just that
#                                       `put-secret-value` ran at least once)
#
# Usage:
#   STACK=MarshalStaging     REGION=us-west-2 ./scripts/smoke.sh
#   STACK=MarshalProduction  REGION=us-west-2 ./scripts/smoke.sh
#
# The logical environment (`staging` | `production`) is derived from the STACK
# name, which in turn drives the env-scoped Secrets Manager paths the smoke
# script inventories.
#
# Requires: aws CLI (with creds), curl.
set -euo pipefail

STACK="${STACK:-MarshalStaging}"
REGION="${REGION:-us-west-2}"

case "$STACK" in
  MarshalStaging)     ENVIRONMENT="staging" ;;
  MarshalProduction)  ENVIRONMENT="production" ;;
  *)
    printf '[smoke] FAIL: unknown STACK=%s — expected MarshalStaging or MarshalProduction\n' "$STACK" >&2
    exit 1
    ;;
esac

log()  { printf '[smoke] %s\n' "$*"; }
die()  { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }
ok()   { printf '[smoke] OK  : %s\n' "$*"; }

get_output() {
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

log "stack=$STACK env=$ENVIRONMENT region=$REGION"

WEBHOOK_URL="$(get_output WebhookApiUrl || true)"
CLUSTER="$(get_output ClusterName || true)"
SERVICE="$(get_output ProcessorServiceName || true)"
INCIDENT_QUEUE="$(get_output IncidentEventsQueueUrl || true)"
DLQ_URL="$(get_output IncidentEventsDlqUrl || true)"

[[ -n "$WEBHOOK_URL"    && "$WEBHOOK_URL"    != "None" ]] || die "WebhookApiUrl missing — has $STACK been deployed?"
[[ -n "$CLUSTER"        && "$CLUSTER"        != "None" ]] || die "ClusterName missing"
[[ -n "$SERVICE"        && "$SERVICE"        != "None" ]] || die "ProcessorServiceName missing"
[[ -n "$INCIDENT_QUEUE" && "$INCIDENT_QUEUE" != "None" ]] || die "IncidentEventsQueueUrl missing"
[[ -n "$DLQ_URL"        && "$DLQ_URL"        != "None" ]] || die "IncidentEventsDlqUrl missing"

log "webhook_url=$WEBHOOK_URL"
log "cluster=$CLUSTER service=$SERVICE"

# ── 1. ECS service is stable ─────────────────────────────────────────────────
log "waiting for ECS processor to stabilize (can take a few minutes on first deploy)…"
aws ecs wait services-stable \
  --region "$REGION" \
  --cluster "$CLUSTER" \
  --services "$SERVICE"
ok "ECS processor is stable"

# ── 2. Webhook ingress is alive ──────────────────────────────────────────────
# POST an unsigned payload to the webhook route. The Lambda's HMAC check must
# reject with 401 before any Zod or SQS work happens. Anything 5xx means the
# Lambda itself crashed before reaching the signature gate.
log "POST $WEBHOOK_URL/webhook/grafana-oncall (unsigned — expect 401)"
attempts=0
until status="$(curl -sS -o /tmp/marshal-smoke-webhook -w '%{http_code}' --max-time 10 \
  -H 'Content-Type: application/json' \
  -d '{"smoke":"test"}' \
  "$WEBHOOK_URL/webhook/grafana-oncall" || echo 000)"; [[ "$status" == "401" ]]; do
  attempts=$((attempts + 1))
  if (( attempts >= 6 )); then
    printf '\n%s\n' "--- webhook body ---" >&2
    cat /tmp/marshal-smoke-webhook >&2 || true
    case "$status" in
      5??) die "webhook returned $status — Lambda crashed before HMAC check" ;;
      000) die "webhook — no response (API Gateway / network failure)" ;;
      *)   die "webhook returned $status — expected 401 (HMAC reject)" ;;
    esac
  fi
  log "  got $status, retrying in 5s… ($attempts/6)"
  sleep 5
done
ok "webhook /webhook/grafana-oncall → 401 (HMAC gate is live)"

# ── 3. Queue depths at rest ──────────────────────────────────────────────────
queue_depth() {
  aws sqs get-queue-attributes \
    --region "$REGION" \
    --queue-url "$1" \
    --attribute-names ApproximateNumberOfMessages \
    --query 'Attributes.ApproximateNumberOfMessages' \
    --output text
}

incident_depth="$(queue_depth "$INCIDENT_QUEUE")"
dlq_depth="$(queue_depth "$DLQ_URL")"
[[ "$incident_depth" == "0" ]] || die "incident queue depth = $incident_depth (expected 0 at rest)"
[[ "$dlq_depth"      == "0" ]] || die "DLQ depth = $dlq_depth (investigate before re-running smoke)"
ok "incident queue + DLQ depth = 0"

# ── 4. Secrets inventory ─────────────────────────────────────────────────────
# Verifies each operator-seeded secret has had `put-secret-value` run at least
# once for this environment. `describe-secret` returning `LastChangedDate` is
# the cheapest reliable signal — we don't fetch values. Secret paths are
# env-scoped so staging and production are inventoried independently.
REQUIRED_SECRETS=(
  "marshal/${ENVIRONMENT}/slack/bot-token"
  "marshal/${ENVIRONMENT}/slack/signing-secret"
  "marshal/${ENVIRONMENT}/slack/app-token"
  "marshal/${ENVIRONMENT}/grafana/oncall-token"
  "marshal/${ENVIRONMENT}/grafana/cloud-token"
  "marshal/${ENVIRONMENT}/grafana/cloud-org-id"
  "marshal/${ENVIRONMENT}/statuspage/api-key"
  "marshal/${ENVIRONMENT}/statuspage/page-id"
  "marshal/${ENVIRONMENT}/github/token"
  "marshal/${ENVIRONMENT}/linear/api-key"
  "marshal/${ENVIRONMENT}/linear/project-id"
  "marshal/${ENVIRONMENT}/linear/team-id"
  "marshal/${ENVIRONMENT}/workos/api-key"
  "marshal/${ENVIRONMENT}/grafana/oncall-webhook-hmac"
  "marshal/${ENVIRONMENT}/grafana-cloud/otlp-auth"
)
missing=()
for id in "${REQUIRED_SECRETS[@]}"; do
  if ! aws secretsmanager describe-secret --region "$REGION" --secret-id "$id" \
        --query 'LastChangedDate' --output text >/dev/null 2>&1; then
    missing+=("$id")
  fi
done
if (( ${#missing[@]} > 0 )); then
  printf '[smoke] FAIL: %d secrets unseeded or missing for %s:\n' "${#missing[@]}" "$ENVIRONMENT" >&2
  printf '         - %s\n' "${missing[@]}" >&2
  printf '       see docs/secrets.md for the seeding CLI.\n' >&2
  exit 1
fi
ok "all ${#REQUIRED_SECRETS[@]} required secrets are seeded for $ENVIRONMENT"

log "smoke passed ($ENVIRONMENT)"
