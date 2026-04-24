#!/usr/bin/env bash
#
# grep-gate — enforce the label-approval gate invariant.
#
# The CorpusWritePort and corpusWriter.addAttack() identifiers are load-
# bearing. Only `src/gate/label-approval-gate.ts` is allowed to reference
# them. Any other file that does is a security regression — fail CI hard.

set -euo pipefail

cd "$(dirname "$0")/../.."

OFFENDERS=$(git grep -n -E 'CorpusWritePort|\.addAttack\s*\(' -- 'src/**/*.ts' ':!src/gate/**' ':!src/ports/index.ts' ':!src/types/corpus.ts' ':!src/corpus/**' ':!src/index.ts' || true)

if [[ -n "${OFFENDERS}" ]]; then
  echo "grep-gate FAIL: corpus-write identifiers found outside src/gate/**"
  echo "${OFFENDERS}"
  echo
  echo "Only the label-approval gate may hold CorpusWritePort or call addAttack()."
  echo "If you genuinely need a new call site, update this script with an explicit"
  echo "allow-list entry and document why — this is a security-critical invariant."
  exit 1
fi

# Second invariant: the pgvector INSERT string lives only in the adapter.
SQL_OFFENDERS=$(git grep -n -E 'INSERT\s+INTO\s+attack_corpus' -- 'src/**/*.ts' ':!src/corpus/pgvector-corpus.ts' || true)
if [[ -n "${SQL_OFFENDERS}" ]]; then
  echo "grep-gate FAIL: 'INSERT INTO attack_corpus' found outside the pgvector adapter"
  echo "${SQL_OFFENDERS}"
  exit 1
fi

echo "grep-gate OK"
