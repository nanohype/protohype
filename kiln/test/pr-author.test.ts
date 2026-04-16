/**
 * PR author tests.
 * github-app.ts imports jose (ESM-only) — mock it at the module boundary.
 */
jest.mock('../lambda/shared/github-app', () => ({
  createPullRequest: jest.fn().mockResolvedValue({ number: 42, html_url: 'https://github.com/org/repo/pull/42' }),
}));

import {
  buildMigrationNotes,
  collectAllChangelogUrls,
  collectAllBreakingChangeCitations,
  buildConsolidatedPrBody,
} from '../lambda/upgrade-worker/pr-author';
import type { MigrationResult } from '../lambda/shared/types';

const samplePatched: MigrationResult = {
  kind: 'patched',
  change: {
    description: 'DynamoDB.putItem renamed to DynamoDBClient.send(new PutItemCommand(...))',
    sourceUrl: 'https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.0.0',
    apiSurface: 'DynamoDB.putItem',
    migration: 'Replace putItem calls with the command pattern.',
  },
  usages: [{ file: 'src/db.ts', lines: [42, 45], excerpt: 'await client.putItem(...)' }],
  patches: [{
    file: 'src/db.ts',
    startLine: 42,
    endLine: 45,
    original: 'await client.putItem(...)',
    replacement: 'await client.send(new PutItemCommand(...))',
    breakingChangeDescription: 'DynamoDB.putItem renamed',
  }],
};

const sampleHumanReview: MigrationResult = {
  kind: 'human-review',
  change: {
    description: 'Streaming API changed — requires architectural decisions',
    sourceUrl: 'https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.0.0',
    apiSurface: 'Readable.stream',
  },
  usages: [{ file: 'src/stream.ts', lines: [10], excerpt: 'const stream = client.stream()' }],
  reason: 'Stream handling requires semantic understanding of the data pipeline.',
};

const sampleNoUsage: MigrationResult = {
  kind: 'no-usage',
  change: {
    description: 'Old callback API removed',
    sourceUrl: 'https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.0.0',
    apiSurface: 'putItem.callback',
  },
};

describe('buildMigrationNotes', () => {
  it('includes changelog URLs', () => {
    const notes = buildMigrationNotes({
      packageName: '@aws-sdk/client-dynamodb',
      fromVersion: '2.0.0',
      toVersion: '3.0.0',
      changelogUrls: ['https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.0.0'],
      migrations: [samplePatched],
    });
    expect(notes).toContain('https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.0.0');
  });

  it('includes patched section with file:line citations', () => {
    const notes = buildMigrationNotes({
      packageName: '@aws-sdk/client-dynamodb',
      fromVersion: '2.0.0',
      toVersion: '3.0.0',
      changelogUrls: [],
      migrations: [samplePatched],
    });
    expect(notes).toContain('src/db.ts');
    expect(notes).toContain('42');
    expect(notes).toContain('Mechanically patched');
  });

  it('includes human-review section with reason', () => {
    const notes = buildMigrationNotes({
      packageName: '@aws-sdk/client-dynamodb',
      fromVersion: '2.0.0',
      toVersion: '3.0.0',
      changelogUrls: [],
      migrations: [sampleHumanReview],
    });
    expect(notes).toContain('human judgment');
    expect(notes).toContain('src/stream.ts');
    expect(notes).toContain('Stream handling requires');
  });

  it('includes no-usage section', () => {
    const notes = buildMigrationNotes({
      packageName: '@aws-sdk/client-dynamodb',
      fromVersion: '2.0.0',
      toVersion: '3.0.0',
      changelogUrls: [],
      migrations: [sampleNoUsage],
    });
    expect(notes).toContain('No usage found');
    expect(notes).toContain('Old callback API removed');
  });

  it('includes the Kiln attribution footer', () => {
    const notes = buildMigrationNotes({
      packageName: 'react',
      fromVersion: '17.0.0',
      toVersion: '18.0.0',
      changelogUrls: [],
      migrations: [],
    });
    expect(notes).toContain('Kiln');
  });
});

describe('collectAllChangelogUrls', () => {
  it('collects URLs from all migration results', () => {
    const urls = collectAllChangelogUrls([samplePatched, sampleHumanReview, sampleNoUsage]);
    expect(urls).toContain('https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.0.0');
    expect(new Set(urls).size).toBe(urls.length);  // no duplicates
  });

  it('returns empty array for empty migrations', () => {
    expect(collectAllChangelogUrls([])).toEqual([]);
  });
});

describe('collectAllBreakingChangeCitations', () => {
  it('collects file:line citations from patched migrations', () => {
    const citations = collectAllBreakingChangeCitations([samplePatched]);
    expect(citations).toHaveLength(1);
    expect(citations[0]!.file).toBe('src/db.ts');
    expect(citations[0]!.lines).toContain(42);
  });

  it('collects file:line citations from human-review migrations', () => {
    const citations = collectAllBreakingChangeCitations([sampleHumanReview]);
    expect(citations).toHaveLength(1);
    expect(citations[0]!.file).toBe('src/stream.ts');
    expect(citations[0]!.lines).toContain(10);
  });

  it('ignores no-usage migrations', () => {
    const citations = collectAllBreakingChangeCitations([sampleNoUsage]);
    expect(citations).toHaveLength(0);
  });
});

describe('buildConsolidatedPrBody', () => {
  it('includes all package names in the consolidated body', () => {
    const body = buildConsolidatedPrBody({
      groupKey: '-aws-sdk-',
      packageUpdates: [
        {
          packageName: '@aws-sdk/client-dynamodb',
          fromVersion: '2.0.0',
          toVersion: '3.0.0',
          changelogUrls: [],
          migrations: [samplePatched],
        },
        {
          packageName: '@aws-sdk/client-s3',
          fromVersion: '2.0.0',
          toVersion: '3.0.0',
          changelogUrls: [],
          migrations: [],
        },
      ],
    });
    expect(body).toContain('@aws-sdk/client-dynamodb');
    expect(body).toContain('@aws-sdk/client-s3');
    expect(body).toContain('-aws-sdk-');
  });
});
