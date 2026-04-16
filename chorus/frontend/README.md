# chorus-frontend

Next.js 16 + React 19 + TailwindCSS PM review UI for chorus.

## Pages

| Path | What it does |
|---|---|
| `/` | Lists pending proposals visible to the caller's squads (server-side ACL on the API). |
| `/proposals/[id]` | Single proposal: source, redacted feedback, status. For pending proposals, action panels for Approve / Reject / Defer. |
| `/sign-in` | Legacy redirect — server-side `redirect()` to the WorkOS hosted login. |
| `/callback` | WorkOS AuthKit callback (`handleAuth()`); processes the auth code and sets the session cookie. |
| `/proposals/[id]/actions/[action]` | Server route handler that forwards Approve / Reject / Defer to the chorus API with the session bearer. |

## Auth flow

1. `@workos-inc/authkit-nextjs` middleware (`src/middleware.ts`)
   redirects unauthenticated requests to the WorkOS hosted sign-in.
2. After sign-in WorkOS redirects to `/callback`, which `handleAuth()`
   processes — setting an encrypted session cookie carrying the
   WorkOS-issued RS256 access token.
3. Server components and the action route resolve the session via
   `withAuth()` and forward `Authorization: Bearer <jwt>` to the
   chorus API.
4. The chorus API verifies that token via `src/lib/auth.ts`
   (`validateAccessToken`) and applies the server-side ACL filter on
   every read.

The frontend never holds chorus data. Stateless view over the API.

## Local dev without WorkOS

Set `CHORUS_DEV_BEARER` in `.env.local` and `lib/api.ts` forwards it
verbatim instead of resolving through the AuthKit session. Only takes
effect when `NODE_ENV !== 'production'`.

## Run

```bash
cp .env.example .env.local
# fill in WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD
# (32+ chars — `openssl rand -base64 32`), WORKOS_REDIRECT_URI,
# CHORUS_API_BASE_URL
npm install
npm run dev   # http://localhost:3001
```

Run the chorus API in another terminal:

```bash
cd ../
npm run build && node dist/src/api/server.js
```

## Production polish

This is functional UI, not finished design. Things human design
iteration should improve before the PM cohort sees it:

- Spacing scale and typographic hierarchy (Tailwind defaults today).
- Empty / loading / error states beyond the placeholder text.
- Animation: cards swap with no transition; an action redirects with
  a hard refresh. A row-removal animation and an optimistic UI for
  the action buttons would feel meaningfully nicer.
- A real evidence drawer / customer summary instead of the truncated
  verbatim.
- Accessibility audit (ARIA roles on the action panels, focus
  management on the post-action redirect, keyboard shortcuts).
- Responsive breakpoints below 640px (desktop-first today).

## Conventions

- Server components by default; only the action panel is `'use client'`.
- `cache: 'no-store'` on every API fetch — the API is the source of
  truth; PM-visible data is never cached.
- Dark mode via `prefers-color-scheme` (no toggle).
- TailwindCSS v4 with a small set of `@layer components` utilities
  (`.card`, `.btn`, `.pill`) so per-page markup stays readable.
