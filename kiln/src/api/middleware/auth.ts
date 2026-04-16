/**
 * Okta OIDC auth middleware.
 * Identity resolved via Okta's JWKS endpoint — never fabricated from email prefix or user ID.
 * Team membership verified per request from the JWT's groups claim, not cached across sessions.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Context, Next } from "hono";
import { config } from "../../config.js";
import { log } from "../../telemetry/otel.js";
import type { OktaIdentity } from "../../types.js";

const JWKS_URL = `https://${config.okta.domain}/oauth2/v1/keys`;
const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

const KILN_TEAM_PREFIX = "kiln-team-";
const KILN_PLATFORM_GROUP = "kiln-platform";

interface OktaClaims extends JWTPayload {
  groups?: string[];
  email?: string;
}

/** Parse Okta group memberships into Kiln team IDs. */
function extractTeamIds(groups: string[]): string[] {
  return groups
    .filter((g) => g.startsWith(KILN_TEAM_PREFIX))
    .map((g) => g.slice(KILN_TEAM_PREFIX.length));
}

/**
 * Hono middleware — verifies Okta JWT and attaches identity to context.
 * Returns 401 on missing/invalid token. Identity resolution uses upstream IdP API only.
 */
export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Bearer token" }, 401);
  }

  const token = authorization.slice(7);

  try {
    const { payload } = await jwtVerify<OktaClaims>(token, JWKS, {
      issuer: `https://${config.okta.domain}`,
      audience: config.okta.audience,
    });

    if (!payload.sub || !payload.email) {
      return c.json({ error: "Token missing required claims (sub, email)" }, 401);
    }

    const groups = payload.groups ?? [];
    const teamIds = extractTeamIds(groups);
    const isPlatformTeam = groups.includes(KILN_PLATFORM_GROUP);

    const identity: OktaIdentity = {
      sub: payload.sub,
      email: payload.email,
      groups,
      teamIds,
    };

    c.set("identity", identity);
    c.set("isPlatformTeam", isPlatformTeam);

    log("info", "Request authenticated", {
      sub: payload.sub,
      teamCount: teamIds.length,
      isPlatformTeam,
    });

    await next();
  } catch (err) {
    log("warn", "JWT verification failed", { err: String(err) });
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

/** Extract the verified identity from Hono context (call after authMiddleware). */
export function getIdentity(c: Context): OktaIdentity {
  const identity = c.get("identity") as OktaIdentity | undefined;
  if (!identity) throw new Error("authMiddleware must run before getIdentity");
  return identity;
}

export function isPlatformTeam(c: Context): boolean {
  return (c.get("isPlatformTeam") as boolean | undefined) ?? false;
}
