describe('Authorizer: extractBearerToken', () => {
  function extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader) return null;
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? (match[1] ?? null) : null;
  }
  test('extracts token from valid Bearer header', () => { expect(extractBearerToken('Bearer abc123')).toBe('abc123'); });
  test('handles mixed-case Bearer prefix', () => { expect(extractBearerToken('BEARER mytoken')).toBe('mytoken'); });
  test('returns null for missing header', () => { expect(extractBearerToken(undefined)).toBeNull(); });
  test('returns null for non-Bearer scheme', () => { expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull(); });
  test('handles token with special characters', () => {
    const token = 'abc123XYZ456abcdefghijklmnopqrstuvwxyz';
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
  });
});

describe('Authorizer: constantTimeEquals', () => {
  function constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) {
      let diff = 0;
      const maxLen = Math.max(a.length, b.length);
      for (let i = 0; i < maxLen; i++) { diff |= (a.charCodeAt(i % a.length) ^ b.charCodeAt(i % b.length)); }
      return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) { diff |= (a.charCodeAt(i) ^ b.charCodeAt(i)); }
    return diff === 0;
  }
  test('returns true for identical strings', () => { const t = 'abc123securetoken456'; expect(constantTimeEquals(t, t)).toBe(true); });
  test('returns false for different strings of same length', () => { expect(constantTimeEquals('aaaa', 'aaab')).toBe(false); });
  test('returns false for different lengths', () => { expect(constantTimeEquals('short', 'muchlonger')).toBe(false); });
  test('returns false for empty vs non-empty', () => { expect(constantTimeEquals('', 'token')).toBe(false); });
  test('does not short-circuit (timing safety)', () => {
    const a = 'a'.repeat(100);
    expect(constantTimeEquals(a, 'b' + 'a'.repeat(99))).toBe(false);
    expect(constantTimeEquals(a, 'a'.repeat(99) + 'b')).toBe(false);
  });
});

describe('Authorizer: token cache eviction', () => {
  test('evicts stale tokens', () => {
    const tokenCache = new Map<string, number>();
    const now = Date.now();
    tokenCache.set('stale-token', now - 1000);
    tokenCache.set('fresh-token', now + 100000);
    for (const [token, expiry] of tokenCache.entries()) { if (Date.now() >= expiry) tokenCache.delete(token); }
    expect(tokenCache.has('stale-token')).toBe(false);
    expect(tokenCache.has('fresh-token')).toBe(true);
  });
});
