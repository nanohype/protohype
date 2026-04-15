import { authkitMiddleware } from '@/lib/auth';

/**
 * AuthKit middleware: redirects unauthenticated requests to the
 * WorkOS hosted sign-in flow and refreshes session cookies on the
 * fly. The `matcher` excludes Next.js internals, static assets, and
 * the `/callback` route AuthKit itself owns.
 */
export default authkitMiddleware();

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|callback).*)'],
};
