import { generateKeyPairSync, createVerify } from 'crypto';
import { signJwt, isServiceAccount, getGoogleAccessToken, _clearTokenCache, GoogleServiceAccount } from '../lambda/switchboard/google-auth';

function generateTestServiceAccount(overrides: Partial<GoogleServiceAccount> = {}): GoogleServiceAccount {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const sa: GoogleServiceAccount = {
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'test-key-id',
    private_key: privateKey,
    client_email: 'test@test-project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  };
  // Stash the public key on the object for test use (not part of the real shape).
  (sa as unknown as { _publicKey: string })._publicKey = publicKey;
  return sa;
}

function decodeJwtPart(segment: string): Record<string, unknown> {
  // base64url → base64 → JSON
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8')) as Record<string, unknown>;
}

describe('isServiceAccount', () => {
  test('accepts a valid service account shape', () => {
    const sa = { type: 'service_account', private_key: 'pk', client_email: 'a@b.iam.gserviceaccount.com' };
    expect(isServiceAccount(sa)).toBe(true);
  });

  test('rejects legacy accessToken shape', () => {
    expect(isServiceAccount({ accessToken: 'ya29.xxx' })).toBe(false);
  });

  test('rejects missing private_key', () => {
    expect(isServiceAccount({ type: 'service_account', client_email: 'a@b' })).toBe(false);
  });

  test('rejects wrong type', () => {
    expect(isServiceAccount({ type: 'user', private_key: 'pk', client_email: 'a@b' })).toBe(false);
  });

  test('rejects null / non-object', () => {
    expect(isServiceAccount(null)).toBe(false);
    expect(isServiceAccount('string')).toBe(false);
    expect(isServiceAccount(undefined)).toBe(false);
  });
});

describe('signJwt', () => {
  test('produces a three-part JWT with correct header + claims', () => {
    const sa = generateTestServiceAccount();
    const jwt = signJwt(sa, 'https://www.googleapis.com/auth/drive', 1_700_000_000);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const header = decodeJwtPart(parts[0]!);
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
    expect(header.kid).toBe('test-key-id');
    const claims = decodeJwtPart(parts[1]!);
    expect(claims.iss).toBe(sa.client_email);
    expect(claims.scope).toBe('https://www.googleapis.com/auth/drive');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_003_600);
  });

  test('signature is verifiable with the matching public key', () => {
    const sa = generateTestServiceAccount();
    const jwt = signJwt(sa, 'scope-value');
    const [header, claims, signature] = jwt.split('.');
    const signingInput = `${header}.${claims}`;
    const sig = Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();
    const publicKey = (sa as unknown as { _publicKey: string })._publicKey;
    expect(verifier.verify(publicKey, sig)).toBe(true);
  });

  test('omits kid header when private_key_id is not provided', () => {
    const sa = generateTestServiceAccount({ private_key_id: undefined });
    const jwt = signJwt(sa, 'scope');
    const header = decodeJwtPart(jwt.split('.')[0]!);
    expect(header).not.toHaveProperty('kid');
  });

  test('uses default token URI when not specified', () => {
    const sa = generateTestServiceAccount({ token_uri: undefined });
    const jwt = signJwt(sa, 'scope');
    const claims = decodeJwtPart(jwt.split('.')[1]!);
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
  });
});

describe('getGoogleAccessToken', () => {
  const originalFetch = global.fetch;
  let fetchCalls: Array<{ url: string; body: string }>;

  beforeEach(() => {
    fetchCalls = [];
    _clearTokenCache();
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: typeof url === 'string' ? url : url.toString(),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(JSON.stringify({ access_token: 'stubbed-token-value', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('exchanges JWT for access token', async () => {
    const sa = generateTestServiceAccount();
    const token = await getGoogleAccessToken(sa, 'https://www.googleapis.com/auth/drive');
    expect(token).toBe('stubbed-token-value');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(fetchCalls[0]!.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(fetchCalls[0]!.body).toContain('assertion=');
  });

  test('caches the access token per (email, scope)', async () => {
    const sa = generateTestServiceAccount();
    await getGoogleAccessToken(sa, 'scope-a');
    await getGoogleAccessToken(sa, 'scope-a'); // same — should hit cache
    expect(fetchCalls).toHaveLength(1);
  });

  test('does not share cache across scopes', async () => {
    const sa = generateTestServiceAccount();
    await getGoogleAccessToken(sa, 'scope-a');
    await getGoogleAccessToken(sa, 'scope-b'); // different scope — new exchange
    expect(fetchCalls).toHaveLength(2);
  });

  test('throws with actionable error on 4xx', async () => {
    global.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch;
    const sa = generateTestServiceAccount();
    await expect(getGoogleAccessToken(sa, 'scope')).rejects.toThrow(/Google token exchange failed/);
  });

  test('throws when token response has error field', async () => {
    global.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_scope', error_description: 'bad' }), { status: 200 })) as typeof fetch;
    const sa = generateTestServiceAccount();
    await expect(getGoogleAccessToken(sa, 'scope')).rejects.toThrow(/invalid_scope/);
  });
});
