#!/usr/bin/env bash
#
# Post-deploy smoke test for an Almanac ECS stack.
#
# Reads the ServiceUrl, ClusterName, and ServiceName outputs from the stack,
# waits for ECS to reach steady state, then curls the live ALB endpoint:
#   1. GET /health           → expect HTTP 200
#   2. GET /oauth/notion/start (no `t=` token)
#                            → expect 4xx (bot knows the provider but rejects
#                               the unsigned URL). Anything 5xx means the
#                               handler itself crashed.
#
# Usage:
#   STACK=AlmanacStaging REGION=us-west-2 ./scripts/smoke.sh
#   STACK=AlmanacProduction                ./scripts/smoke.sh
#
# Requires: aws CLI (with creds), curl.
set -euo pipefail

STACK="${STACK:-AlmanacStaging}"
REGION="${REGION:-us-west-2}"

log() { printf '[smoke] %s\n' "$*"; }
die() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }

get_output() {
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

log "stack=$STACK region=$REGION"

SERVICE_URL="$(get_output ServiceUrl || true)"
CLUSTER="$(get_output ClusterName || true)"
SERVICE="$(get_output ServiceName || true)"

[[ -n "$SERVICE_URL" && "$SERVICE_URL" != "None" ]] || die "ServiceUrl missing — has $STACK been deployed?"
[[ -n "$CLUSTER"     && "$CLUSTER"     != "None" ]] || die "ClusterName missing"
[[ -n "$SERVICE"     && "$SERVICE"     != "None" ]] || die "ServiceName missing"

log "service_url=$SERVICE_URL"
log "cluster=$CLUSTER service=$SERVICE"

log "waiting for ECS service to stabilize (can take a few minutes on first deploy)…"
aws ecs wait services-stable \
  --region "$REGION" \
  --cluster "$CLUSTER" \
  --services "$SERVICE"
log "ECS service is stable"

# /health — the definitive liveness signal. Retry briefly to cover ALB warmup.
log "GET $SERVICE_URL/health"
attempts=0
until status="$(curl -sS -o /tmp/almanac-smoke-health -w '%{http_code}' --max-time 10 "$SERVICE_URL/health" || echo 000)"; [[ "$status" == "200" ]]; do
  attempts=$((attempts + 1))
  if (( attempts >= 6 )); then
    printf '\n%s\n' "--- /health body ---" >&2
    cat /tmp/almanac-smoke-health >&2 || true
    die "/health did not return 200 after $attempts attempts (last: $status)"
  fi
  log "  got $status, retrying in 10s… ($attempts/6)"
  sleep 10
done
log "  /health → 200"

# /oauth/:provider/start without a signed token — handler is reachable and
# rejects gracefully (4xx). 5xx means the handler itself crashed.
log "GET $SERVICE_URL/oauth/notion/start (expect non-5xx)"
status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$SERVICE_URL/oauth/notion/start" || echo 000)"
case "$status" in
  5??) die "/oauth/notion/start returned $status — handler crashed" ;;
  000) die "/oauth/notion/start — no response (network / curl failure)" ;;
  *)   log "  /oauth/notion/start → $status (non-5xx, handler alive)" ;;
esac

log "smoke passed"
