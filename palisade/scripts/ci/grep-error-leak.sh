#!/usr/bin/env bash
#
# grep-error-leak — forbid layer-identity / model-name / upstream-latency
# strings in the proxy error path. Attackers must not be able to tell WHICH
# layer fired, WHICH model we're using, or HOW slow the upstream is.
#
# The only allowed error shape is `{ code: "REQUEST_REJECTED", trace_id }`.

set -euo pipefail

cd "$(dirname "$0")/../.."

# Grep the proxy + honeypot for strings that would leak detection-path info
# inside a Hono `c.json(...)` reject body.
LEAKS=$(git grep -n -E 'c\.json\([^)]*(heuristics|classifier|corpus-match|bedrock|anthropic|openai|claude|gpt)' -- 'src/proxy/**/*.ts' 'src/honeypot/**/*.ts' || true)

# Also forbid returning `error` or `message` fields from the reject path
# except for the standard shape. The grep is conservative — it catches the
# field NAME anywhere inside a c.json() response.
SHAPE_LEAKS=$(git grep -n -E 'c\.json\(\{[^}]*(error|message|detail):' -- 'src/proxy/**/*.ts' || true)

if [[ -n "${LEAKS}" || -n "${SHAPE_LEAKS}" ]]; then
  echo "grep-error-leak FAIL: error-path response contains forbidden identifier or field"
  [[ -n "${LEAKS}" ]] && echo "${LEAKS}"
  [[ -n "${SHAPE_LEAKS}" ]] && echo "${SHAPE_LEAKS}"
  echo
  echo "Error responses must use only { code: 'REQUEST_REJECTED', trace_id } via rejectBody()."
  exit 1
fi

echo "grep-error-leak OK"
