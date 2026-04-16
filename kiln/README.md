# Kiln

Dependency-upgrade automation service. Where Renovate and Dependabot bump the version and link the changelog, **Kiln reads the vendor changelog, identifies breaking changes against your specific codebase's usage, applies the mechanical patches, and opens a GitHub PR with the migration work already done.**

## What Kiln does

| Step | What happens |
|---|---|
| 1. Polling | Watches npm for new versions of configured deps |
| 2. Changelog fetch | Fetches changelog from GitHub Releases / npmjs.com (strict domain allowlist) |
| 3. Classification | Claude Haiku 4.5 classifies breaking changes from the changelog |
| 4. Codebase scan | GitHub code search finds usage sites of affected symbols |
| 5. Migration synthesis | Claude Sonnet 4.6 / Opus 4.6 writes patches for each usage site |
| 6. PR opened | GitHub App opens a PR with Migration Notes: changelog URLs, file:line citations |

## Architecture

```
npm registry
    │ new version detected
    ▼
npm Poller (scheduled)
    │
    ▼
Upgrade Pipeline (per dep/group)
  ├─ Changelog fetcher (allowlisted domains)
  ├─ Bedrock classifier (Haiku 4.5)
  ├─ GitHub code scanner (usage sites)
  ├─ Bedrock migration synthesizer (Sonnet 4.6 / Opus 4.6)
  └─ GitHub PR creator (App-signed commits)

DynamoDB
  ├─ kiln-teams (team configs — teamId partition key)
  ├─ kiln-upgrades (audit ledger — teamId + upgradeId)
  ├─ kiln-changelogs (changelog cache — TTL 7d)
  └─ kiln-rate-limit (GitHub token bucket — shared across instances)

Hono HTTP API
  ├─ GET/POST/PUT/DELETE /teams/:teamId
  ├─ GET/POST /teams/:teamId/upgrades
  └─ GET /healthz, /readyz
```

## Local development

```bash
cd kiln
cp .env.example .env
# Edit .env with your values

npm install
npm run build
npm run dev
```

## Build phases

```bash
npm install        # install
npm run build      # tsc compile
npm run lint       # eslint + prettier check
npm test           # vitest with coverage (≥70% threshold)
npm run docs       # typedoc API docs → docs/api/
```

## Configuration

All config comes from environment variables. See [`.env.example`](.env.example) for the full list.

Key required vars:
- `KILN_TEAMS_TABLE`, `KILN_UPGRADES_TABLE`, `KILN_CHANGELOGS_TABLE`, `KILN_RATE_LIMIT_TABLE`
- `GITHUB_APP_SECRET_ARN` — Secrets Manager ARN for the GitHub App private key
- `OKTA_DOMAIN` — your Okta domain (for OIDC auth)

## Security model

- **GitHub App only** — Kiln commits via scoped installation tokens; no PATs
- **Allowlisted changelog domains** — arbitrary URLs rejected (SSRF prevention)
- **Per-tenant DynamoDB isolation** — every query scopes on `teamId`; cross-team reads are structurally impossible
- **Shared rate limiter** — DynamoDB-backed token bucket across all Lambda instances
- **Audit writes awaited** — `putUpgradeRecord` and `updateUpgradeStatus` are always `await`ed; no fire-and-forget
- **Bedrock inference logging: NONE** — enforced via CDK at deploy time

## Grouping strategies

Matches [Renovate's `groupName` config](https://docs.renovatebot.com/configuration-options/#groupname) semantics:

```json
// per-dep (default) — one PR per dependency
{ "kind": "per-dep" }

// per-family — one consolidated PR for @aws-sdk/* packages
{ "kind": "per-family", "pattern": "@aws-sdk/*" }

// per-release-window — one PR covering all deps in the window
{ "kind": "per-release-window", "windowDays": 7 }
```

## V1 scope

- TypeScript/JavaScript repos
- Top-level deps only (no transitive)
- 5 flagship deps: `@aws-sdk/*`, `react`, `next`, `prisma`, `@types/node`
- No auto-merge — Kiln opens PRs, humans merge

## API docs

Generated docs available at `docs/api/` after running `npm run docs`.
