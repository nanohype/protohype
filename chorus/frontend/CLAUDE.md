# chorus-frontend

Next.js 16 + React 19 + TailwindCSS v4 PM review UI for chorus.

## What This Is

The frontend for the chorus feedback-matching service. A thin, stateless server-rendered view over the chorus API. The service of record is the chorus API — this app does not persist anything client-side beyond the encrypted WorkOS AuthKit session cookie.

## How It Works

```
browser
   │
   │  cookie: WorkOS AuthKit session
   ▼
Next.js server
   │
   │  Authorization: Bearer <jwt from session>
   ▼
chorus API (src/api/server.ts)
   │
   ▼
Postgres (ACL filter in SQL) → Linear (on approve)
```

Every page is a server component that fetches via `lib/api.ts` with `cache: 'no-store'`. The only client component is `ProposalActions.tsx` — it owns form state for the approve / reject / defer panels and uses `useTransition` for the pending indicator. Action submissions POST to `/proposals/[id]/actions/[action]` route handlers, which re-forward to the chorus API with the session bearer.

## Architecture

| Path | Purpose |
|---|---|
| `src/app/layout.tsx` | Root shell — header, max-width container, color-scheme-driven design tokens. |
| `src/app/page.tsx` | Pending-proposals list (server component). Applies the caller's squad ACL via the API. |
| `src/app/proposals/[id]/page.tsx` | Single proposal view with `<ProposalActions/>` mounted when status is pending. |
| `src/app/proposals/[id]/actions/[action]/route.ts` | Server route handler — forwards approve/reject/defer to the API. |
| `src/app/callback/route.ts` | WorkOS AuthKit `handleAuth()` — processes the authorization code. |
| `src/app/sign-in/page.tsx` | Server-side redirect to the WorkOS hosted login. |
| `src/components/ProposalCard.tsx` | Compact proposal preview row used by the list view. Link element, keyboard-accessible. |
| `src/components/ProposalActions.tsx` | Client component with form state + `useTransition`. |
| `src/components/StatusPill.tsx` | LINK / NEW / status pill. |
| `src/lib/api.ts` | Typed fetch wrapper around the chorus API. Resolves the session token for every request. |
| `src/lib/auth.ts` | WorkOS AuthKit session helpers. |
| `src/middleware.ts` | AuthKit middleware — unauthenticated requests redirect to the hosted login. |
| `src/app/globals.css` | Design tokens (`--color-*`, `--motion-*`) and Tailwind `@layer components` utilities (`.card`, `.btn`, `.pill`). |

## Commands

```
npm install        # install deps
npm run dev        # next dev on :3001
npm run build      # production build
npm run lint       # eslint --max-warnings=0
npm run format     # prettier --write
npm run format:check
npm run typecheck  # tsc --noEmit
```

`npm run lint` and `npm run format:check` are both expected to pass clean in CI.

## Configuration

All set in `.env.local` (copy from `.env.example`):

| Var | What |
|---|---|
| `WORKOS_API_KEY` | WorkOS management API key |
| `WORKOS_CLIENT_ID` | matches `WORKOS_CLIENT_ID` on the chorus API |
| `WORKOS_COOKIE_PASSWORD` | 32+ chars; `openssl rand -base64 32` |
| `WORKOS_REDIRECT_URI` | e.g. `http://localhost:3001/callback` |
| `CHORUS_API_BASE_URL` | e.g. `http://localhost:3000` |
| `CHORUS_DEV_BEARER` | dev-only bypass for local work without WorkOS |

## Conventions

- **Server components by default.** Only mark `'use client'` when the component genuinely needs browser-side state or refs. Currently `ProposalActions.tsx` is the only client component.
- **No client-side caching.** Every API fetch is `cache: 'no-store'`. PM-visible data is read-your-writes from the API on every render.
- **Design tokens.** Every color comes from `--color-*` CSS variables in `globals.css`; every motion duration/easing from `--motion-*` variables. No raw hex in JSX, no `transition-[100ms]` literals.
- **Animation is purposeful.** Apply motion to communicate state changes (card hover, submit pending, status transition) — not decoration. Use `transform` and `opacity`; never animate `width`, `height`, `top`, or `left`. Easing uses the custom `--motion-spring` variable, not raw cubic-bezier literals.
- **Accessibility.** Interactive elements must be keyboard-reachable and expose correct ARIA labels. Inputs have `<label>` pairs; buttons have `aria-busy` when pending; errors use `role="alert"`.
- **Responsive.** The layout is designed mobile-first. Below 640px everything stacks vertically. Use Tailwind breakpoints (`sm:`, `md:`) for wider viewports.
- **TypeScript strict.** No `any`, no `@ts-ignore`. Props are typed at their declaration site.

## Testing

There is no vitest suite in the frontend today. Typecheck + lint + format-check is the full static gate. Interactive testing is covered by the chorus API's integration test on the route handlers; PM-flow end-to-end belongs in a future Playwright pass.

## Dependencies

| Package | Why |
|---|---|
| `next` | Framework. App Router, server components. |
| `react` / `react-dom` | v19 — needed for `useTransition` on the action panel. |
| `@workos-inc/authkit-nextjs` | Session cookie + middleware + AuthKit redirect. |
| `tailwindcss` v4 | Utility CSS + `@layer components` for `.card` / `.btn` / `.pill`. |
| `autoprefixer`, `postcss`, `@tailwindcss/postcss` | Tailwind build pipeline. |
| `eslint`, `prettier`, `typescript` | Static gate. |
