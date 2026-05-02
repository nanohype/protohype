// WorkOS AuthKit / User Management JWT verifier.
//
// Uses `jose` with a remote JWKS — WorkOS issues standard OIDC JWTs so the
// mechanics are identical to any other JWKS-backed verify. Audience (clientId)
// and issuer are pinned at adapter construction so a misconfigured env turns
// into a loud 401 rather than a silent downgrade.
//
// JWKS URL derivation: WorkOS exposes per-client JWKS at
//   `${issuer}/sso/jwks/${clientId}`
// The adapter accepts an explicit override (cfg.jwksUrl) for deployments that
// proxy or pin a different location.

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IdentityPort } from "../../core/ports.js";
import { asTeamId, err, ok, type VerifiedIdentity } from "../../types.js";

export interface WorkOSAdapterConfig {
  issuer: string;
  clientId: string;
  jwksUrl?: string;
  teamClaim: string;
}

export function makeWorkOSIdentityAdapter(cfg: WorkOSAdapterConfig): IdentityPort {
  const jwksUrl = cfg.jwksUrl ?? `${cfg.issuer.replace(/\/$/, "")}/sso/jwks/${cfg.clientId}`;
  const jwks = createRemoteJWKSet(new URL(jwksUrl));

  return {
    async verifyBearer(bearer) {
      const token = bearer.replace(/^bearer\s+/i, "").trim();
      if (!token) {
        return err({ kind: "Forbidden", source: "workos", message: "missing bearer token" });
      }
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: cfg.issuer,
          audience: cfg.clientId,
        });
        const rawTeamId = payload[cfg.teamClaim];
        if (typeof rawTeamId !== "string" || rawTeamId.length === 0) {
          return err({
            kind: "Forbidden",
            source: "workos",
            message: `missing or non-string claim "${cfg.teamClaim}"`,
          });
        }
        const userId = typeof payload.sub === "string" ? payload.sub : "";
        const scopesRaw = payload["scp"] ?? payload["scope"];
        const scopes =
          Array.isArray(scopesRaw)
            ? scopesRaw.filter((s): s is string => typeof s === "string")
            : typeof scopesRaw === "string"
              ? scopesRaw.split(/\s+/).filter(Boolean)
              : [];
        const identity: VerifiedIdentity = {
          teamId: asTeamId(rawTeamId),
          userId,
          scopes,
          issuer: cfg.issuer,
          audience: cfg.clientId,
          ...(typeof payload.email === "string" ? { email: payload.email } : {}),
        };
        return ok(identity);
      } catch (e) {
        return err({ kind: "Forbidden", source: "workos", message: asMessage(e) });
      }
    },
  };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
