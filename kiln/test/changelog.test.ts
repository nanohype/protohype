/**
 * Changelog fetcher tests.
 */
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import nock from 'nock';

const ddbMock = mockClient(DynamoDBDocumentClient);

import { fetchChangelog } from '../lambda/upgrade-worker/changelog';

beforeEach(() => {
  ddbMock.reset();
  nock.cleanAll();
});

afterAll(() => {
  nock.cleanAll();
  nock.restore();
});

describe('fetchChangelog', () => {
  it('returns cached content when available', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        cacheKey: 'react#18.3.0',
        content: '# Changelog\n## 18.3.0\nSome changes',
        fetchedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      },
    });

    const result = await fetchChangelog('react', '18.3.0', 'https://github.com/facebook/react/releases/tag/v18.3.0');
    expect(result).toBe('# Changelog\n## 18.3.0\nSome changes');
  });

  it('fetches from URL when not cached', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    nock('https://github.com')
      .get('/facebook/react/releases/tag/v18.3.0')
      .reply(200, '# React 18.3.0\n\nBreaking change: ...');

    const result = await fetchChangelog('react', '18.3.0', 'https://github.com/facebook/react/releases/tag/v18.3.0');
    expect(result).toContain('React 18.3.0');
  });

  it('rejects disallowed domains', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await expect(
      fetchChangelog('react', '18.3.0', 'https://evil.com/steal-secrets')
    ).rejects.toThrow();
  });

  it('throws on HTTP error', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    nock('https://github.com')
      .get('/facebook/react/releases/tag/v18.3.0')
      .reply(404, 'Not Found');

    await expect(
      fetchChangelog('react', '18.3.0', 'https://github.com/facebook/react/releases/tag/v18.3.0')
    ).rejects.toThrow('404');
  });

  it('truncates extremely large changelogs', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const hugeContent = 'x'.repeat(50_000);
    nock('https://github.com')
      .get('/facebook/react/releases/tag/v18.3.0')
      .reply(200, hugeContent);

    const result = await fetchChangelog('react', '18.3.0', 'https://github.com/facebook/react/releases/tag/v18.3.0');
    expect(result.length).toBeLessThan(50_000);
    expect(result).toContain('truncated');
  });

  it('treats expired cache items as misses', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        cacheKey: 'react#18.3.0',
        content: 'old content',
        fetchedAt: '2020-01-01T00:00:00Z',
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      },
    });
    ddbMock.on(PutCommand).resolves({});

    nock('https://github.com')
      .get('/facebook/react/releases/tag/v18.3.0')
      .reply(200, 'fresh content');

    const result = await fetchChangelog('react', '18.3.0', 'https://github.com/facebook/react/releases/tag/v18.3.0');
    expect(result).toBe('fresh content');
  });
});
