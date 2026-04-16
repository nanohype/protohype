import type { NextAuthOptions } from "next-auth";

/**
 * next-auth configuration using Okta OIDC.
 *
 * Identity is resolved via Okta SCIM — team membership is read from the
 * Okta groups claim on the ID token and verified per-request, never cached
 * across sessions.
 */
export const authOptions: NextAuthOptions = {
  providers: [
    {
      id: "okta",
      name: "Okta",
      type: "oauth",
      wellKnown: `${process.env.OKTA_ISSUER}/.well-known/openid-configuration`,
      clientId: process.env.OKTA_CLIENT_ID!,
      clientSecret: process.env.OKTA_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: "openid email profile groups",
          response_type: "code",
        },
      },
      idToken: true,
      checks: ["pkce", "state"],
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name ?? profile.preferred_username,
          email: profile.email,
          // Groups are embedded in the Okta ID token when the Okta app is
          // configured to include the groups claim.
          groups: (profile.groups as string[]) ?? [],
        };
      },
    },
  ],
  session: {
    strategy: "jwt",
    // 8-hour session — matches typical enterprise workday; forces re-auth
    // so team membership is never stale beyond a working day.
    maxAge: 8 * 60 * 60,
  },
  callbacks: {
    /**
     * Embed Okta groups and user id into the JWT so we can resolve team
     * membership on every API request without an extra Okta call.
     * Group→teamId mapping happens server-side in the API layer.
     */
    async jwt({ token, profile }) {
      if (profile) {
        token.sub = profile.sub as string;
        token.groups = (profile as Record<string, unknown>).groups as string[];
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as Record<string, unknown>).id = token.sub;
        (session.user as Record<string, unknown>).groups = token.groups;
      }
      return session;
    },
  },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
};
