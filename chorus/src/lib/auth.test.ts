import { describe, it, expect } from 'vitest';
import * as jose from 'jose';
import { canAccessEvidence, verifyTokenWith, type AuthClaims } from './auth.js';

const baseClaims: AuthClaims = {
  sub: 'user-alice',
  email: 'alice@example.com',
  squadIds: ['growth'],
  isCsm: false,
};

describe('canAccessEvidence', () => {
  it('grants access when the user is in a squad on the evidence ACL', () => {
    expect(canAccessEvidence(baseClaims, ['growth'], [])).toBe(true);
  });

  it('denies access when the user has no matching squad', () => {
    expect(canAccessEvidence(baseClaims, ['billing'], [])).toBe(false);
  });

  it('grants access when the user is a CSM listed on the evidence ACL', () => {
    const csm: AuthClaims = { ...baseClaims, isCsm: true, squadIds: [] };
    expect(canAccessEvidence(csm, [], ['user-alice'])).toBe(true);
  });

  it('denies access when the user is a CSM but not on the evidence ACL', () => {
    const csm: AuthClaims = { ...baseClaims, isCsm: true, squadIds: [] };
    expect(canAccessEvidence(csm, [], ['other-csm'])).toBe(false);
  });

  it('denies access when squad overlap is empty and CSM ACL is empty', () => {
    expect(canAccessEvidence(baseClaims, [], [])).toBe(false);
  });

  it('grants access when any of the users squads matches', () => {
    const multi: AuthClaims = { ...baseClaims, squadIds: ['growth', 'billing'] };
    expect(canAccessEvidence(multi, ['billing'], [])).toBe(true);
  });
});

describe('verifyTokenWith', () => {
  const ISSUER = 'https://api.workos.test';
  const CLIENT_ID = 'client_test_123';

  async function setup() {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
    const jwk = await jose.exportJWK(publicKey);
    jwk.kid = 'k1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const jwks = jose.createLocalJWKSet({ keys: [jwk] });
    return { privateKey, jwks };
  }

  type PrivateKey = Awaited<ReturnType<typeof jose.generateKeyPair>>['privateKey'];

  async function mint(
    privateKey: PrivateKey,
    payload: jose.JWTPayload,
    overrides: { issuer?: string } = {},
  ): Promise<string> {
    return new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(overrides.issuer ?? ISSUER)
      .setSubject(payload.sub as string)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  it('projects permissions[] → squadIds and roles[] → isCsm', async () => {
    const { privateKey, jwks } = await setup();
    const token = await mint(privateKey, {
      sub: 'user-1',
      email: 'u1@example.com',
      client_id: CLIENT_ID,
      permissions: ['squad:growth', 'squad:billing', 'unrelated:perm'],
      roles: ['csm', 'pm'],
    });
    const claims = await verifyTokenWith(token, { jwks, issuer: ISSUER, clientId: CLIENT_ID });
    expect(claims.sub).toBe('user-1');
    expect(claims.email).toBe('u1@example.com');
    expect(claims.squadIds).toEqual(['growth', 'billing']);
    expect(claims.isCsm).toBe(true);
  });

  it('rejects a token whose client_id claim does not match', async () => {
    const { privateKey, jwks } = await setup();
    const token = await mint(privateKey, {
      sub: 'user-2',
      client_id: 'client_other_999',
      permissions: [],
      roles: [],
    });
    await expect(
      verifyTokenWith(token, { jwks, issuer: ISSUER, clientId: CLIENT_ID }),
    ).rejects.toThrow(/client_id/);
  });

  it('rejects a token whose issuer does not match', async () => {
    const { privateKey, jwks } = await setup();
    const token = await mint(
      privateKey,
      { sub: 'user-3', client_id: CLIENT_ID, permissions: [], roles: [] },
      { issuer: 'https://impostor.example' },
    );
    await expect(
      verifyTokenWith(token, { jwks, issuer: ISSUER, clientId: CLIENT_ID }),
    ).rejects.toThrow();
  });

  it('defaults squadIds and isCsm when permissions and roles are absent', async () => {
    const { privateKey, jwks } = await setup();
    const token = await mint(privateKey, { sub: 'user-4', client_id: CLIENT_ID });
    const claims = await verifyTokenWith(token, { jwks, issuer: ISSUER, clientId: CLIENT_ID });
    expect(claims.squadIds).toEqual([]);
    expect(claims.isCsm).toBe(false);
  });
});
