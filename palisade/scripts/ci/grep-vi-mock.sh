#!/usr/bin/env bash
#
# grep-vi-mock — forbid `vi.mock(<sdk-package>)` in tests. Palisade uses
# port-based DI; tests inject typed fakes. AWS clients go through
# aws-sdk-client-mock (client-level), not module-level mocking.

set -euo pipefail

cd "$(dirname "$0")/../.."

OFFENDERS=$(git grep -n -E "vi\.mock\(\s*['\"](@aws-sdk/|ioredis|pg|@anthropic-ai|openai|hono|@hono/|@opentelemetry)" -- 'src/**/*.test.ts' || true)

if [[ -n "${OFFENDERS}" ]]; then
  echo "grep-vi-mock FAIL: vi.mock(<sdk-package>) is banned"
  echo "${OFFENDERS}"
  echo
  echo "Use port-based DI. Inject typed fakes on the source-side factory."
  echo "AWS clients use aws-sdk-client-mock (client-level injection)."
  exit 1
fi

echo "grep-vi-mock OK"
