# watchtower evals

Labeled suites that gate classifier and memo-drafter quality. Run with the scaffolded `watchtower-evals` package (`packages/evals/`) against a live Bedrock endpoint, or adapt the suites to a test harness of your own.

## Suites

| Suite                                     | What it tests                                                   | Top-line metric                         |
| ----------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| `applicability-classifier-precision.yaml` | `(rule-change, client) → disposition` accuracy on labeled pairs | precision on `alert` dispositions ≥ 0.9 |

Coming in follow-up PRs:

- `memo-drafter-rubric.yaml` — rubric-scored memo quality (does the memo identify the affected products / jurisdictions / effective dates?)
- `dedup-no-regress.yaml` — re-ingesting an identical change must not fan out a second classify wave

## Running

The scaffolded harness under `packages/evals/` is a starting point. Watchtower-specific integration (point `packages/evals/bin/run-evals.ts` at the classifier's live Bedrock endpoint rather than the direct-Anthropic / OpenAI defaults) is a follow-up task — see the adopter TODO in `eval/applicability-classifier-precision.yaml` for the expected input / expect shape.

Adopters wiring this up: use `createClassifier` with the real `BedrockRuntimeClient`, fan the cases through it, and compare `result.disposition` against `expect.disposition`. Count precision/recall per disposition.
