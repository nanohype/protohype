# Kiln — CLAUDE.md

## Project conventions

Inherits from parent repo `/workspace/protohype` conventions. Overrides below.

### Language & runtime
- TypeScript 5.8.x, Node.js 24 (Active LTS)
- ESM modules (`"type": "module"`)
- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`)

### Test framework
- **Vitest 3.x** (not Jest)
- Coverage via `@vitest/coverage-v8`
- Run: `npm test`
- Coverage gate: ≥70% lines/functions/branches

### Build tool
- `tsc` for build (`npm run build` → `dist/`)
- No bundler — Node.js native ESM

### Lint / format
- **ESLint 9** with typescript-eslint flat config (`eslint.config.js`)
- **Prettier** for formatting (`.prettierrc.json`)
- Run: `npm run lint`

### File layout
```
src/
  api/           — Hono HTTP routes + middleware
  core/          — Domain logic (changelog, github, bedrock, grouping, npm, codebase)
  db/            — DynamoDB repositories
  workers/       — Poller + upgrade pipeline orchestrator
  notifications/ — Slack + Linear
  telemetry/     — OpenTelemetry setup
  types.ts       — Shared domain types
  config.ts      — Environment config (validated at startup)
  index.ts       — Service entrypoint

tests/
  unit/          — Per-module unit tests
  integration/   — Orchestrator integration tests (mocked external clients)
```

### Key invariants
- Every DynamoDB query scopes on `teamId` partition key — cross-team reads are structurally impossible
- Audit writes (`putUpgradeRecord`, `updateUpgradeStatus`) are always `await`ed — no fire-and-forget
- Changelog domain allowlist enforced in `src/core/changelog/fetcher.ts` — arbitrary URLs rejected
- GitHub rate limiter is DynamoDB-backed (`src/core/github/rate-limiter.ts`) — no in-memory rate limiting
- All external HTTP calls have explicit per-call timeouts (see `config.ts`)
- Identity resolution via Okta JWKS only — never fabricated from email prefix
- GitHub writes via App installation tokens only — no PATs

### Dependency notes
- `zod` pinned to 3.x (not 4.x) — Zod 4 API is incompatible with current usage patterns in this codebase
- `jose` used for Okta JWT verification (not `jsonwebtoken` which lacks ESM support)
