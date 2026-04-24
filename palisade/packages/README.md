# packages/

Reference implementations scaffolded from nanohype templates. **Not imported by palisade's runtime.**

Each directory here is a standalone, self-contained package produced by
`nanohype scaffold <template>` — kept in-tree so:

- a client forking palisade can lift the relevant module in place of the in-tree adapter in `src/`
- the scaffold artifacts remain auditable against the nanohype template catalog
- CI and docs can reference these as the canonical shapes palisade draws from

Palisade's application code (`src/index.ts` and downstream) re-implements the
minimum surface it needs against narrow typed ports. The goals: keep the
runtime small, avoid cross-package type drift, and make the DI story obvious.

## Exclusions

These directories are excluded from palisade's toolchain:

- `vitest.config.ts` — `packages/**` in `test.exclude`
- `eslint.config.mjs` — `packages/**` in `ignores`
- `.prettierignore` — `packages/`
- `.dockerignore` — `packages/`
- `tsconfig.json` — `packages/` is outside `include`

If you want to work on one of these packages, `cd` into it — each has its own
`package.json`, `tsconfig.json`, and test config. They are not meant to be built
or typechecked from palisade's root.

## Current contents

| Directory | Template |
|---|---|
| `ci-eval/` | `ci-eval` |
| `database/` | `module-database-ts` |
| `fine-tune/` | `fine-tune-pipeline` |
| `guardrails/` | `guardrails` |
| `llm-gateway/` | `module-llm-gateway` |
| `llm-providers/` | `module-llm-providers` |
| `observability/` | `module-observability-ts` |
| `queue/` | `module-queue-ts` |
| `rate-limit/` | `module-rate-limit-ts` |
| `semantic-cache/` | `module-semantic-cache` |
| `vector-store/` | `module-vector-store` |
