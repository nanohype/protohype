import { redirect } from 'next/navigation';
import { getSignInUrl } from '@/lib/auth';

/**
 * Legacy `/sign-in` path — kept so external links still work. Redirects
 * server-side to the WorkOS hosted login. AuthKit's middleware does
 * the same redirect for unauthenticated requests, so this page is only
 * hit when a user clicks an explicit sign-in link.
 *
 * For local development without WorkOS, set `CHORUS_DEV_BEARER` and
 * the API call layer (`lib/api.ts`) uses it directly without going
 * through this flow.
 */
export default async function SignInPage() {
  redirect(await getSignInUrl());
}
