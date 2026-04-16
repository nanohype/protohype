import { describe, it, expect } from 'vitest';
import { buildPrBody, buildBranchName, buildPrTitle } from '../pr-author.js';
import type { MigrationNote } from '../types.js';

const NOTE_SIMPLE: MigrationNote = {
  dependency: 'react',
  fromVersion: '18.3.1',
  toVersion: '19.1.0',
  changelogUrl: 'https://github.com/facebook/react/releases/tag/v19.1.0',
  breakingChanges: [],
  patches: [],
  humanReviewRequired: false,
};

const NOTE_WITH_BREAKING: MigrationNote = {
  dependency: '@aws-sdk/client-s3',
  fromVersion: '2.1.0',
  toVersion: '3.0.0',
  changelogUrl: 'https://github.com/aws/aws-sdk-js-v3/releases',
  breakingChanges: [
    {
      description: 'createClient renamed to createS3Client',
      file: 'src/storage.ts',
      line: 14,
      requiresHumanReview: false,
    },
    {
      description: 'Credential chain changed — verify manually',
      requiresHumanReview: true,
    },
  ],
  patches: [
    {
      file: 'src/storage.ts',
      originalLine: 14,
      originalCode: 'createClient(',
      patchedCode: 'createS3Client(',
    },
  ],
  humanReviewRequired: true,
};

describe('buildPrBody', () => {
  it('includes a Migration Notes heading', () => {
    const body = buildPrBody([NOTE_SIMPLE]);
    expect(body).toContain('## Migration Notes');
  });

  it('includes the changelog URL for every dependency', () => {
    const body = buildPrBody([NOTE_SIMPLE, NOTE_WITH_BREAKING]);
    expect(body).toContain('github.com/facebook/react');
    expect(body).toContain('github.com/aws/aws-sdk-js-v3');
  });

  it('names every breaking change', () => {
    const body = buildPrBody([NOTE_WITH_BREAKING]);
    expect(body).toContain('createClient renamed to createS3Client');
    expect(body).toContain('Credential chain changed');
  });

  it('includes file:line reference for located breaking changes', () => {
    const body = buildPrBody([NOTE_WITH_BREAKING]);
    expect(body).toContain('src/storage.ts:14');
  });

  it('marks human-review-required breaking changes with ⚠️', () => {
    const body = buildPrBody([NOTE_WITH_BREAKING]);
    expect(body).toContain('⚠️');
  });

  it('marks mechanically-patched changes with ✅', () => {
    const body = buildPrBody([NOTE_WITH_BREAKING]);
    expect(body).toContain('✅');
  });

  it('lists patches applied', () => {
    const body = buildPrBody([NOTE_WITH_BREAKING]);
    expect(body).toContain('createClient(');
    expect(body).toContain('createS3Client(');
  });

  it('includes human review warning when humanReviewRequired is true', () => {
    const body = buildPrBody([NOTE_WITH_BREAKING]);
    expect(body).toMatch(/human.*review.*required/i);
  });

  it('notes "no breaking changes" when list is empty', () => {
    const body = buildPrBody([NOTE_SIMPLE]);
    expect(body).toMatch(/no breaking changes/i);
  });

  it('handles multiple migration notes in one body', () => {
    const body = buildPrBody([NOTE_SIMPLE, NOTE_WITH_BREAKING]);
    expect(body).toContain('react');
    expect(body).toContain('@aws-sdk/client-s3');
  });
});

describe('buildBranchName', () => {
  it('always starts with feat/kiln-', () => {
    const name = buildBranchName('aws-sdk');
    expect(name.startsWith('feat/kiln-')).toBe(true);
  });

  it('sanitises non-alphanumeric characters to dashes', () => {
    const name = buildBranchName('@aws-sdk/client-s3');
    expect(name).not.toContain('@');
    expect(name).not.toContain('/');
  });

  it('is lowercase', () => {
    const name = buildBranchName('MyDependency');
    expect(name).toBe(name.toLowerCase());
  });

  it('appends a timestamp', () => {
    const ts = 1_700_000_000_000;
    const name = buildBranchName('react', ts);
    expect(name).toContain(String(ts));
  });

  it('produces unique names for different timestamps', () => {
    const a = buildBranchName('react', 1000);
    const b = buildBranchName('react', 2000);
    expect(a).not.toBe(b);
  });
});

describe('buildPrTitle', () => {
  it('names the dependency for a single-dep upgrade', () => {
    const title = buildPrTitle([NOTE_SIMPLE]);
    expect(title).toContain('react');
    expect(title).toContain('18.3.1');
    expect(title).toContain('19.1.0');
    expect(title).toContain('[kiln]');
  });

  it('lists all dep names for multi-dep upgrade', () => {
    const title = buildPrTitle([NOTE_SIMPLE, NOTE_WITH_BREAKING]);
    expect(title).toContain('react');
    expect(title).toContain('@aws-sdk/client-s3');
    expect(title).toContain('[kiln]');
  });
});
