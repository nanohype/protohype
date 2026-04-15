/**
 * WorkOS AuthKit — single auth touchpoint for the frontend. Other
 * modules import these helpers from `@/lib/auth` rather than reaching
 * into `@workos-inc/authkit-nextjs` directly, so swapping providers
 * again later only edits this file.
 *
 * The session carries a WorkOS-issued RS256 access token, which
 * `lib/api.ts` forwards to the chorus API as
 * `Authorization: Bearer <token>`. The chorus API verifies that token
 * via `src/lib/auth.ts` (`validateAccessToken`), so the same JWT is
 * the source of truth on both sides.
 *
 * Env (production):
 *   WORKOS_API_KEY              — server-only API key from WorkOS
 *   WORKOS_CLIENT_ID            — AuthKit client id
 *   WORKOS_COOKIE_PASSWORD      — 32+ char random session-cookie key
 *   WORKOS_REDIRECT_URI         — e.g. https://chorus.acme.com/callback
 *
 * Env (local dev without WorkOS):
 *   CHORUS_DEV_BEARER           — used directly by lib/api.ts when
 *                                 NODE_ENV !== 'production'.
 */
export {
  withAuth,
  signOut,
  getSignInUrl,
  getSignUpUrl,
  handleAuth,
  authkitMiddleware,
} from '@workos-inc/authkit-nextjs';
