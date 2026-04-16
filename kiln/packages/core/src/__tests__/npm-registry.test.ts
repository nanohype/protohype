import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { fetchPackageInfo, checkForUpdate } from '../npm-registry.js';

// ---------------------------------------------------------------------------
// MSW server intercepting undici fetch
// ---------------------------------------------------------------------------
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const REACT_FIXTURE = {
  name: 'react',
  'dist-tags': { latest: '19.1.0' },
  versions: { '18.3.1': {}, '19.0.0': {}, '19.1.0': {} },
  time: {
    created: '2013-05-29T00:00:00.000Z',
    modified: '2024-12-01T00:00:00.000Z',
    '18.3.1': '2024-04-26T00:00:00.000Z',
    '19.0.0': '2024-12-05T00:00:00.000Z',
    '19.1.0': '2025-01-15T00:00:00.000Z',
  },
  repository: { url: 'https://github.com/facebook/react.git' },
};

const SCOPED_FIXTURE = {
  name: '@aws-sdk/client-s3',
  'dist-tags': { latest: '3.500.0' },
  versions: { '3.499.0': {}, '3.500.0': {} },
  time: { '3.499.0': '2024-01-01T00:00:00.000Z', '3.500.0': '2024-02-01T00:00:00.000Z' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('fetchPackageInfo', () => {
  it('returns package metadata for an unscoped package', async () => {
    server.use(
      http.get('https://registry.npmjs.org/react', () =>
        HttpResponse.json(REACT_FIXTURE),
      ),
    );

    const info = await fetchPackageInfo('react');
    expect(info.name).toBe('react');
    expect(info.latestVersion).toBe('19.1.0');
    expect(info.versions).toContain('19.1.0');
    expect(info.versions).toContain('18.3.1');
  });

  it('sets publishTimes keyed by version, excluding created/modified', async () => {
    server.use(
      http.get('https://registry.npmjs.org/react', () =>
        HttpResponse.json(REACT_FIXTURE),
      ),
    );

    const info = await fetchPackageInfo('react');
    expect(info.publishTimes['19.1.0']).toBe('2025-01-15T00:00:00.000Z');
    expect(info.publishTimes['created']).toBeUndefined();
    expect(info.publishTimes['modified']).toBeUndefined();
  });

  it('derives a GitHub changelog URL from repository field', async () => {
    server.use(
      http.get('https://registry.npmjs.org/react', () =>
        HttpResponse.json(REACT_FIXTURE),
      ),
    );

    const info = await fetchPackageInfo('react');
    expect(info.changelogUrl).toBe('https://github.com/facebook/react/releases');
  });

  it('handles scoped packages (@aws-sdk/client-s3)', async () => {
    server.use(
      http.get('https://registry.npmjs.org/%40aws-sdk%2Fclient-s3', () =>
        HttpResponse.json(SCOPED_FIXTURE),
      ),
    );

    const info = await fetchPackageInfo('@aws-sdk/client-s3');
    expect(info.name).toBe('@aws-sdk/client-s3');
    expect(info.latestVersion).toBe('3.500.0');
  });

  it('throws on non-200 response', async () => {
    server.use(
      http.get('https://registry.npmjs.org/unknown-pkg-xyz', () =>
        new HttpResponse(null, { status: 404 }),
      ),
    );

    await expect(fetchPackageInfo('unknown-pkg-xyz')).rejects.toThrow(/404/);
  });

  it('uses a custom registry URL', async () => {
    server.use(
      http.get('https://my-registry.example.com/react', () =>
        HttpResponse.json(REACT_FIXTURE),
      ),
    );

    const info = await fetchPackageInfo('react', 'https://my-registry.example.com');
    expect(info.latestVersion).toBe('19.1.0');
  });
});

describe('checkForUpdate', () => {
  it('returns null when current version matches latest', async () => {
    server.use(
      http.get('https://registry.npmjs.org/react', () =>
        HttpResponse.json(REACT_FIXTURE),
      ),
    );

    const result = await checkForUpdate('react', '19.1.0');
    expect(result).toBeNull();
  });

  it('returns new version info when an update is available', async () => {
    server.use(
      http.get('https://registry.npmjs.org/react', () =>
        HttpResponse.json(REACT_FIXTURE),
      ),
    );

    const result = await checkForUpdate('react', '18.3.1');
    expect(result).not.toBeNull();
    expect(result?.latestVersion).toBe('19.1.0');
    expect(result?.changelogUrl).toContain('github.com');
  });
});
