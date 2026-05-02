#!/usr/bin/env bash
#
# One-shot seeder for a kiln environment's Secrets Manager payload.
#
# Reads a single JSON file (see secrets.template.json for the shape), then for
# each key writes the value to Secrets Manager at `kiln/${env}/${key}`. Robust
# against both states a secret can be in:
#   - already created, empty or stale  → put-secret-value (new version)
#   - not yet created                  → create-secret, then put-secret-value
#
# Value conventions:
#   - string                         → raw value, stored as SecretString
#   - object (JSON)                  → serialized and stored as SecretString
#   - string starting "@file:<path>" → contents of <path> stored as SecretString
#                                      (useful for the GitHub App PEM)
#   - null                           → skipped (for optional secrets)
#
# Safety rails:
#   - Any value containing the sentinel `REPLACE_ME` aborts the run before a
#     single API call goes out — guards against half-filled templates.
#   - `--dry-run` lists what would be written without calling AWS.
#   - Never logs secret values. Only key names + AWS action + byte count.
#   - `--shred` deletes any `@file:` sources after successful upload (optional,
#     opt-in; safe default is to leave them alone).
#
# Usage:
#   scripts/seed-secrets.sh --env staging     --file kiln-secrets.staging.json
#   scripts/seed-secrets.sh --env production  --file kiln-secrets.production.json
#   scripts/seed-secrets.sh --env staging     --file ... --dry-run
#   scripts/seed-secrets.sh --env staging     --file ... --shred
#
# Defaults: --region us-west-2, --file kiln-secrets.${env}.json
#
# Requires: aws CLI (creds that can put/create secrets), jq.
set -euo pipefail

ENVIRONMENT=""
FILE=""
REGION="us-west-2"
DRY_RUN=0
SHRED=0

usage() {
  cat <<EOF
Usage: $0 --env {staging|production} [--file PATH] [--region REGION] [--dry-run] [--shred]

Seeds kiln secrets for the named environment from a JSON file.
See secrets.template.json for the file shape.

Required: github-app-private-key (PEM), grafana-cloud/otlp-auth (JSON)
Optional: workos/api-key, slack/webhook-url, linear/api-key (set to null to skip)

--shred deletes @file: sources after successful upload.
EOF
  exit "${1:-1}"
}

while (( $# > 0 )); do
  case "$1" in
    --env)     ENVIRONMENT="${2:?missing value for --env}"; shift 2 ;;
    --file)    FILE="${2:?missing value for --file}"; shift 2 ;;
    --region)  REGION="${2:?missing value for --region}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --shred)   SHRED=1; shift ;;
    -h|--help) usage 0 ;;
    *)         printf 'unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

[[ "$ENVIRONMENT" == "staging" || "$ENVIRONMENT" == "production" ]] \
  || { printf '[seed] --env must be "staging" or "production" (got "%s")\n' "$ENVIRONMENT" >&2; exit 1; }
[[ -z "$FILE" ]] && FILE="kiln-secrets.${ENVIRONMENT}.json"
[[ -f "$FILE" ]] || { printf '[seed] file not found: %s\n' "$FILE" >&2; exit 1; }
command -v jq     >/dev/null || { printf '[seed] jq required\n'     >&2; exit 1; }
command -v aws    >/dev/null || { printf '[seed] aws cli required\n' >&2; exit 1; }
command -v base64 >/dev/null || { printf '[seed] base64 required\n' >&2; exit 1; }

log() { printf '[seed] %s\n' "$*"; }
die() { printf '[seed] FAIL: %s\n' "$*" >&2; exit 1; }
ok()  { printf '[seed] OK  : %s\n' "$*"; }

# Canonical list of secret paths kiln recognizes. Must stay in lockstep with
# secrets.template.json keys and the consumers' hardcoded secret names in
# src/adapters/compose.ts + src/config.ts. Required keys are non-nullable;
# optional keys may be null to skip.
REQUIRED_KEYS=(
  "github-app-private-key"
  "grafana-cloud/otlp-auth"
)
OPTIONAL_KEYS=(
  "workos/api-key"
  "slack/webhook-url"
  "linear/api-key"
)
ALL_KEYS=("${REQUIRED_KEYS[@]}" "${OPTIONAL_KEYS[@]}")

log "env=$ENVIRONMENT region=$REGION file=$FILE dry_run=$DRY_RUN shred=$SHRED"

# ── 1. Validate shape ───────────────────────────────────────────────────────
jq empty "$FILE" 2>/dev/null || die "$FILE is not valid JSON"

missing=()
for k in "${ALL_KEYS[@]}"; do
  if [[ "$(jq --arg k "$k" 'has($k)' "$FILE")" != "true" ]]; then
    missing+=("$k")
  fi
done
if (( ${#missing[@]} > 0 )); then
  printf '[seed] FAIL: %s is missing required keys:\n' "$FILE" >&2
  printf '         - %s\n' "${missing[@]}" >&2
  exit 1
fi

# Required keys must not be null.
for k in "${REQUIRED_KEYS[@]}"; do
  v="$(jq -r --arg k "$k" '.[$k]' "$FILE")"
  [[ "$v" == "null" ]] && die "required key '$k' is null in $FILE (set a value or remove it from REQUIRED_KEYS)"
done

# Reject any REPLACE_ME sentinel anywhere (string OR nested).
if jq -r '.. | select(type == "string")' "$FILE" | grep -q 'REPLACE_ME'; then
  die "$FILE still contains 'REPLACE_ME' — fill in every required value before seeding"
fi

# ── 2. Auto-compute basic_auth for grafana-cloud/otlp-auth ──────────────────
# The Grafana Cloud OTLP endpoint uses HTTP basic auth: base64("<id>:<token>").
# Operators can supply `basic_auth` directly OR supply `instance_id` + `api_token`
# and let the seeder compute it. Saves operators from remembering the shell
# incantation and keeps the format machine-consistent.
OTLP_JSON="$(jq -c '."grafana-cloud/otlp-auth"' "$FILE")"
if [[ "$OTLP_JSON" != "null" ]]; then
  have_basic="$(jq 'has("basic_auth")' <<<"$OTLP_JSON")"
  if [[ "$have_basic" == "false" ]]; then
    instance_id="$(jq -r '.instance_id // empty' <<<"$OTLP_JSON")"
    api_token="$(jq -r '.api_token // empty' <<<"$OTLP_JSON")"
    if [[ -z "$instance_id" || -z "$api_token" ]]; then
      die "grafana-cloud/otlp-auth needs either 'basic_auth' OR both 'instance_id' + 'api_token'"
    fi
    basic_auth="$(printf '%s:%s' "$instance_id" "$api_token" | base64 | tr -d '\n')"
    OTLP_JSON="$(jq --arg b "$basic_auth" '. + {basic_auth: $b}' <<<"$OTLP_JSON")"
    log "grafana-cloud/otlp-auth: basic_auth auto-computed from instance_id + api_token"
  fi
fi

# ── 3. Seed loop ────────────────────────────────────────────────────────────
PAYLOAD_FILE="$(mktemp -t kiln-seed.XXXXXX)"
SHRED_LIST=()
trap 'rm -f "$PAYLOAD_FILE"' EXIT

put_or_create() {
  local id="$1" value_file="$2" byte_count="$3"
  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$id" \
       --query 'ARN' --output text >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --region "$REGION" \
      --secret-id "$id" \
      --secret-string "file://$value_file" \
      --query 'VersionId' --output text >/dev/null
    ok "put    : $id ($byte_count bytes)"
  else
    aws secretsmanager create-secret \
      --region "$REGION" \
      --name "$id" \
      --secret-string "file://$value_file" \
      --description "kiln ${ENVIRONMENT} — seeded by scripts/seed-secrets.sh" \
      --query 'ARN' --output text >/dev/null
    ok "create : $id ($byte_count bytes)"
  fi
}

seed_one() {
  local key="$1"
  local id="kiln/${ENVIRONMENT}/${key}"

  local json
  # The grafana-cloud/otlp-auth key uses the computed JSON (with basic_auth
  # injected if it was missing); all other keys come straight from the file.
  if [[ "$key" == "grafana-cloud/otlp-auth" ]]; then
    json="$OTLP_JSON"
  else
    json="$(jq -c --arg k "$key" '.[$k]' "$FILE")"
  fi

  # Skip optional nulls.
  if [[ "$json" == "null" ]]; then
    log "skip   : $id (null)"
    return 0
  fi

  local value
  case "$json" in
    \"@file:*\")
      # Value is "@file:/abs/path" — read the file as raw bytes.
      local path
      path="$(jq -r --arg k "$key" '.[$k]' "$FILE" | sed 's|^@file:||')"
      [[ -f "$path" ]] || die "$key: referenced file not found: $path"
      value="$(cat "$path")"
      SHRED_LIST+=("$path")
      ;;
    \"*\")
      # Plain string.
      value="$(jq -r --arg k "$key" '.[$k]' "$FILE")"
      [[ -n "$value" ]] || die "$key has empty string value in $FILE"
      ;;
    \{*)
      # JSON object — serialize as-is.
      value="$json"
      ;;
    *)
      die "$key has unsupported value type in $FILE (got: $json)"
      ;;
  esac

  local bytes
  bytes="$(printf '%s' "$value" | wc -c | tr -d ' ')"

  if (( DRY_RUN == 1 )); then
    log "DRY    : $id ($bytes bytes)"
    return 0
  fi

  printf '%s' "$value" > "$PAYLOAD_FILE"
  put_or_create "$id" "$PAYLOAD_FILE" "$bytes"
}

for key in "${ALL_KEYS[@]}"; do
  seed_one "$key"
done

# ── 3. Shred @file: sources (opt-in) ─────────────────────────────────────────
if (( DRY_RUN == 0 && SHRED == 1 )); then
  for p in "${SHRED_LIST[@]:-}"; do
    [[ -z "$p" ]] && continue
    if command -v shred >/dev/null; then
      shred -u "$p" 2>/dev/null && log "shred  : $p"
    else
      # macOS: shred isn't standard. rm -P overwrites once before delete.
      rm -P "$p" 2>/dev/null && log "rm -P  : $p"
    fi
  done
fi

log "seeded ${#REQUIRED_KEYS[@]} required + $(( ${#ALL_KEYS[@]} - ${#REQUIRED_KEYS[@]} )) optional keys for ${ENVIRONMENT}"
if (( DRY_RUN == 0 )); then
  log "next   : verify by running 'aws secretsmanager list-secrets --filters Key=name,Values=kiln/${ENVIRONMENT}/'"
fi
