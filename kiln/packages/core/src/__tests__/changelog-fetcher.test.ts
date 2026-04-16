import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { isDomainAllowed, fetchChangelog, DOMAIN_ALLOWLIST } from '../changelog-fetcher.js';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('isDomainAllowed', () => {
  it('allows all domains in the allowlist', () => {
    for (const domain of DOMAIN_ALLOWLIST) {
      expect(isDomainAllowed(`https://${domain}/path`)).toBe(true);
    }
  });

  it('allows subdomains of allowlisted domains', () => {
    expect(isDomainAllowed('https://docs.github.com/releases')).toBe(true);
    expect(isDomainAllowed('https://pkg.npmjs.com/package/react')).toBe(true);
    expect(isDomainAllowed('https://docs.aws.amazon.com/something')).toBe(true);
  });

  it('blocks non-allowlisted domains', () => {
    expect(isDomainAllowed('https://evil.com/steal')).toBe(false);
    expect(isDomainAllowed('https://attacker.github.com.evil.com/path')).toBe(false);
    expect(isDomainAllowed('https://internal-host/admin')).toBe(false);
    expect(isDomainAllowed('https://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('blocks malformed URLs', () => {
    expect(isDomainAllowed('not-a-url')).toBe(false);
    expect(isDomainAllowed('')).toBe(false);
  });
});

describe('fetchChangelog', () => {
  it('fetches content from an allowlisted URL', async () => {
    server.use(
      http.get('https://github.com/facebook/react/releases', () =>
        HttpResponse.text('## React 19.1.0\n- New features'),
      ),
    );

    const text = await fetchChangelog('https://github.com/facebook/react/releases');
    expect(text).toContain('React 19.1.0');
  });

  it('throws SSRF error for a blocked domain', async () => {
    await expect(
      fetchChangelog('https://evil.com/changelog'),
    ).rejects.toThrow(/SSRF protection/);
  });

  it('throws SSRF error if redirect target is blocked', async () => {
    server.use(
      http.get(
        'https://github.com/some/package/releases',
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://evil.com/steal' },
          }),
      ),
    );

    await expect(
      fetchChangelog('https://github.com/some/package/releases'),
    ).rejects.toThrow(/SSRF protection/);
  });

  it('follows a redirect to an allowlisted domain', async () => {
    server.use(
      http.get(
        'https://github.com/pkg/CHANGELOG.md',
        () =>
          new HttpResponse(null, {
            status: 301,
            headers: {
              Location: 'https://raw.githubusercontent.com/pkg/main/CHANGELOG.md',
            },
          }),
      ),
      http.get('https://raw.githubusercontent.com/pkg/main/CHANGELOG.md', () =>
        HttpResponse.text('# Changelog\n- v2.0.0'),
      ),
    );

    const text = await fetchChangelog('https://github.com/pkg/CHANGELOG.md');
    expect(text).toContain('Changelog');
  });

  it('throws on HTTP error status', async () => {
    server.use(
      http.get('https://github.com/missing/releases', () =>
        new HttpResponse(null, { status: 404 }),
      ),
    );

    await expect(
      fetchChangelog('https://github.com/missing/releases'),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('throws on too many redirects', async () => {
    // Set up a redirect chain longer than maxRedirects
    server.use(
      http.get('https://github.com/a/b', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://github.com/b/c' },
        }),
      ),
      http.get('https://github.com/b/c', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://github.com/c/d' },
        }),
      ),
      http.get('https://github.com/c/d', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://github.com/d/e' },
        }),
      ),
      http.get('https://github.com/d/e', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://github.com/e/f' },
        }),
      ),
    );

    await expect(
      fetchChangelog('https://github.com/a/b'),
    ).rejects.toThrow(/Too many redirects/);
  });
});
