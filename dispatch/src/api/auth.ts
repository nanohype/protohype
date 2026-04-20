/**
 * WorkOS session-token validation + approver authorization.
 *
 * Verifies the WorkOS AuthKit-issued JWT against the WorkOS JWKS, plus
 * issuer, audience (the WorkOS client_id), and expiry. On any validation
 * failure it throws — the Fastify hook turns that into a 401. Non-approver
 * authenticated callers get 403 from isApprover.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Approvers } from './config.js';

export interface SessionClaims extends JWTPayload {
  sub: string;          // WorkOS user id
  email?: string;
  org_id?: string;      // WorkOS organization membership
  sid?: string;         // WorkOS session id
}

export interface Authenticator {
  verify(token: string): Promise<SessionClaims>;
}

export function createAuthenticator(options: { issuer: string; clientId: string }): Authenticator {
  const issuer = options.issuer.replace(/\/$/, '');
  const jwksUrl = new URL(`${issuer}/sso/jwks/${options.clientId}`);
  const jwks = createRemoteJWKSet(jwksUrl);
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: options.clientId,
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new Error('Session token missing sub claim');
      }
      return payload as SessionClaims;
    },
  };
}

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  return match ? match[1].trim() : null;
}

export function isApprover(claims: SessionClaims, approvers: Approvers): boolean {
  return claims.sub === approvers.cosUserId || approvers.backupApproverIds.includes(claims.sub);
}
