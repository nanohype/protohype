# kiln/web

Next.js 16 frontend for Kiln — team configuration management and PR activity feed.

## Inherits from

`../CLAUDE.md` (kiln project) → `../../CLAUDE.md` (protohype root)

## Commands

```bash
npm ci               # Install from lockfile
npm run dev          # Dev server (localhost:3000)
npm run build        # Production build
npm run lint         # ESLint over src/
npm run typecheck    # tsc --noEmit
npm test             # Vitest with coverage
npm run docs         # TypeDoc API docs → docs/
```

## What is here

- `src/app/(app)/prs/` — PR activity feed (Kiln-authored PRs with migration notes)
- `src/app/(app)/settings/` — Team configuration (repos, grouping, notifications, skip list)
- `src/app/(auth)/auth/` — Okta SSO sign-in and error pages
- `src/app/api/` — Next.js API routes (nextauth, health)
- `src/components/` — React components: PRCard, BreakingChangeItem, MetricsStrip, Sidebar, UI primitives
- `src/lib/` — API client, auth options, Zod schemas, utilities
- `src/types/` — Shared TypeScript types (wire types matching Kiln API)

## Testing

Vitest + @testing-library/react. Run `npm test`. Tests live next to source files (`*.test.ts`, `*.test.tsx`).

Do not mock Next.js App Router internals. Mock at the `next/navigation` and `next-auth/react` boundary (see `src/test/setup.ts`).

## Env

See `.env.example`. Copy to `.env.local` for local development.
