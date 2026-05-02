# LLM evals

Gated behind `KILN_RUN_EVALS=1`. Hits real Bedrock in a dev account — not part of the default test run.

## What's measured

- **Classifier (Haiku)** — F1 against a seed corpus of 30 real changelogs with ground-truth breaking-change labels in `fixtures/changelogs/`. Target ≥ 0.85.
- **Synthesizer (Sonnet / Opus escalation)** — Claude-as-judge rubric scoring precision of import rewrites, hallucination rate, patch compilability. Target ≥ 0.8 precision, zero hallucinated APIs across the corpus.

## Running

```bash
KILN_RUN_EVALS=1 npm run test:evals
```

Requires AWS credentials (dev account) with `bedrock:InvokeModel` on Haiku/Sonnet/Opus. Budget ~$0.50/run.

## Adding corpus

Drop a `<pkg>-<fromVersion>-<toVersion>.md` file into `fixtures/changelogs/` and a matching `.expected.json` with the labeled breaking changes. Format documented in `fixtures/SCHEMA.md`.
