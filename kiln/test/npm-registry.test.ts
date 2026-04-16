/**
 * npm registry tests using nock to mock HTTP calls.
 */
import nock from 'nock';
import { fetchLatestVersion } from '../lambda/upgrade-poller/npm-registry';
import type { WatchedPackage } from '../lambda/shared/types';

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.restore();
});

const reactPkg: WatchedPackage = { name: 'react', policy: 'latest' };

describe('fetchLatestVersion', () => {
  it('returns latest version when newer than current', async () => {
    nock('https://registry.npmjs.org')
      .get('/react')
      .reply(200, {
        name: 'react',
        'dist-tags': { latest: '18.3.0' },
        versions: {
          '18.3.0': { version: '18.3.0', repository: { url: 'https://github.com/facebook/react.git' } },
          '17.0.0': { version: '17.0.0' },
        },
        time: { '18.3.0': '2024-04-01T00:00:00Z', '17.0.0': '2021-10-01T00:00:00Z' },
      });

    const result = await fetchLatestVersion(reactPkg, '17.0.0');
    expect(result).not.toBeNull();
    expect(result!.latestVersion).toBe('18.3.0');
    expect(result!.packageName).toBe('react');
  });

  it('returns null when already at latest version', async () => {
    nock('https://registry.npmjs.org')
      .get('/react')
      .reply(200, {
        name: 'react',
        'dist-tags': { latest: '18.3.0' },
        versions: { '18.3.0': { version: '18.3.0' } },
        time: { '18.3.0': '2024-04-01T00:00:00Z' },
      });

    const result = await fetchLatestVersion(reactPkg, '18.3.0');
    expect(result).toBeNull();
  });

  it('returns null when target is not newer', async () => {
    nock('https://registry.npmjs.org')
      .get('/react')
      .reply(200, {
        name: 'react',
        'dist-tags': { latest: '17.0.0' },
        versions: { '17.0.0': { version: '17.0.0' } },
        time: { '17.0.0': '2021-10-01T00:00:00Z' },
      });

    // Current version is newer than registry
    const result = await fetchLatestVersion(reactPkg, '18.3.0');
    expect(result).toBeNull();
  });

  it('skips versions in the skip list', async () => {
    nock('https://registry.npmjs.org')
      .get('/react')
      .reply(200, {
        name: 'react',
        'dist-tags': { latest: '18.3.0' },
        versions: {
          '18.3.0': { version: '18.3.0' },
          '18.2.0': { version: '18.2.0' },
          '17.0.0': { version: '17.0.0' },
        },
        time: {
          '18.3.0': '2024-04-01T00:00:00Z',
          '18.2.0': '2023-06-01T00:00:00Z',
          '17.0.0': '2021-10-01T00:00:00Z',
        },
      });

    const pkgWithSkip: WatchedPackage = { name: 'react', policy: 'latest', skipVersions: ['18.3.0'] };
    const result = await fetchLatestVersion(pkgWithSkip, '17.0.0');
    expect(result).not.toBeNull();
    expect(result!.latestVersion).toBe('18.2.0');
  });

  it('respects next-minor policy', async () => {
    nock('https://registry.npmjs.org')
      .get('/react')
      .reply(200, {
        name: 'react',
        'dist-tags': { latest: '19.0.0' },
        versions: {
          '19.0.0': { version: '19.0.0' },
          '18.3.0': { version: '18.3.0' },
          '18.2.0': { version: '18.2.0' },
        },
        time: {
          '19.0.0': '2025-01-01T00:00:00Z',
          '18.3.0': '2024-04-01T00:00:00Z',
          '18.2.0': '2023-06-01T00:00:00Z',
        },
      });

    const pkgNextMinor: WatchedPackage = { name: 'react', policy: 'next-minor' };
    const result = await fetchLatestVersion(pkgNextMinor, '18.0.0');
    expect(result).not.toBeNull();
    expect(result!.latestVersion).toBe('18.3.0');  // stays within major 18
    expect(result!.latestVersion).not.toBe('19.0.0');
  });

  it('uses GitHub releases URL when repository is on github.com', async () => {
    nock('https://registry.npmjs.org')
      .get('/react')
      .reply(200, {
        name: 'react',
        'dist-tags': {},
        versions: {
          '18.3.0': {
            version: '18.3.0',
            repository: { url: 'https://github.com/facebook/react.git' },
          },
        },
        time: { '18.3.0': '2024-04-01T00:00:00Z' },
      });

    const result = await fetchLatestVersion(reactPkg, '17.0.0');
    expect(result!.changelogUrl).toContain('github.com/facebook/react');
  });

  it('falls back to npmjs.com when no GitHub repo', async () => {
    nock('https://registry.npmjs.org')
      .get('/react')
      .reply(200, {
        name: 'react',
        'dist-tags': {},
        versions: { '18.3.0': { version: '18.3.0' } },
        time: { '18.3.0': '2024-04-01T00:00:00Z' },
      });

    const result = await fetchLatestVersion(reactPkg, '17.0.0');
    expect(result!.changelogUrl).toContain('npmjs.com');
  });

  it('throws on non-200 registry response', async () => {
    nock('https://registry.npmjs.org').get('/react').reply(500, 'Internal Server Error');
    await expect(fetchLatestVersion(reactPkg, '17.0.0')).rejects.toThrow();
  });
});
