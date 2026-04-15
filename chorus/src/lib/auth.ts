import * as jose from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './observability.js';

interface WorkOSConfig {
  issuer: string;
  clientId: string;
  jwksUri: string;
}

let _config: WorkOSConfig | undefined;
let _jwks: jose.JWTVerifyGetKey | undefined;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is required`);
  return v;
}

function getConfig(): WorkOSConfig {
  if (!_config) {
    const issuer = process.env['WORKOS_ISSUER'] ?? 'https://api.workos.com';
    const clientId = required('WORKOS_CLIENT_ID');
    _config = {
      issuer,
      clientId,
      jwksUri: `${issuer}/sso/jwks/${clientId}`,
    };
  }
  return _config;
}

function getJwks(): jose.JWTVerifyGetKey {
  if (!_jwks) _jwks = jose.createRemoteJWKSet(new URL(getConfig().jwksUri));
  return _jwks;
}

export interface AuthClaims {
  sub: string;
  email?: string | undefined;
  squadIds: string[];
  isCsm: boolean;
}

export interface VerifyDeps {
  jwks: jose.JWTVerifyGetKey;
  issuer: string;
  clientId: string;
}

/**
 * Verify a WorkOS AuthKit access token and project it onto the
 * application's claim shape.
 *
 * AuthKit tokens differ from Okta in two ways that drive the code
 * here:
 *   1. There is no `aud` claim — `iss` and `client_id` are how WorkOS
 *      scopes a token to a given application, so we verify both.
 *   2. There is no `groups` claim — squad / CSM membership lives in
 *      `permissions[]` (prefix `squad:`) and `roles[]` (literal `csm`).
 *      Both are configured per-user in the WorkOS dashboard.
 */
export async function verifyTokenWith(token: string, deps: VerifyDeps): Promise<AuthClaims> {
  const { payload } = await jose.jwtVerify(token, deps.jwks, {
    issuer: deps.issuer,
    algorithms: ['RS256'],
  });
  if (payload['client_id'] !== deps.clientId) {
    throw new Error('client_id claim does not match WORKOS_CLIENT_ID');
  }
  const permissions = (payload['permissions'] as string[] | undefined) ?? [];
  const roles = (payload['roles'] as string[] | undefined) ?? [];
  return {
    sub: payload.sub as string,
    email: payload['email'] as string | undefined,
    squadIds: permissions
      .filter((p) => p.startsWith('squad:'))
      .map((p) => p.slice('squad:'.length)),
    isCsm: roles.includes('csm'),
  };
}

export function validateAccessToken(token: string): Promise<AuthClaims> {
  const cfg = getConfig();
  return verifyTokenWith(token, { jwks: getJwks(), issuer: cfg.issuer, clientId: cfg.clientId });
}

export function canAccessEvidence(
  claims: AuthClaims,
  evidenceAclSquadIds: string[],
  evidenceAclCsmIds: string[],
): boolean {
  if (claims.isCsm && evidenceAclCsmIds.includes(claims.sub)) return true;
  return claims.squadIds.some((s) => evidenceAclSquadIds.includes(s));
}

export interface AuthedRequest extends Request {
  user?: AuthClaims;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const auth = req.headers['authorization'];
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }
  validateAccessToken(token)
    .then((claims) => {
      req.user = claims;
      next();
    })
    .catch((err) => {
      logger.warn('JWT invalid', { error: String(err) });
      res.status(401).json({ error: 'Invalid token' });
    });
}
