import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join, tmpdir } from 'path';
import { scanForUsages, countImports } from '../codebase-scanner.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kiln-scanner-test-'));

  // src/index.ts — imports @aws-sdk/client-s3 and uses GetObjectCommand
  await writeFile(
    join(tmpDir, 'index.ts'),
    `import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
const client = new S3Client({});
const cmd = new GetObjectCommand({ Bucket: 'my-bucket', Key: 'my-key' });
`,
  );

  // src/utils.ts — another usage
  await writeFile(
    join(tmpDir, 'utils.ts'),
    `import { PutObjectCommand } from '@aws-sdk/client-s3';
export function upload() { return new PutObjectCommand({}); }
`,
  );

  // dist/bundle.js — should be excluded
  await mkdir(join(tmpDir, 'dist'), { recursive: true });
  await writeFile(
    join(tmpDir, 'dist', 'bundle.js'),
    `const s3 = require('@aws-sdk/client-s3');`,
  );

  // node_modules — should be excluded
  await mkdir(join(tmpDir, 'node_modules', '@aws-sdk'), { recursive: true });
  await writeFile(
    join(tmpDir, 'node_modules', '@aws-sdk', 'index.js'),
    `module.exports = {};`,
  );

  // Plain text file — should be skipped (not a source extension)
  await writeFile(join(tmpDir, 'README.md'), `Uses @aws-sdk/client-s3`);
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('scanForUsages', () => {
  it('finds usages matching a pattern in source files', async () => {
    const results = await scanForUsages(tmpDir, ["from '@aws-sdk/client-s3'"]);
    expect(results.length).toBeGreaterThanOrEqual(2);
    const files = results.map((r) => r.file);
    expect(files.some((f) => f.endsWith('index.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('utils.ts'))).toBe(true);
  });

  it('excludes node_modules and dist by default', async () => {
    const results = await scanForUsages(tmpDir, ["@aws-sdk/client-s3"]);
    const files = results.map((r) => r.file);
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
    expect(files.every((f) => !f.includes('dist'))).toBe(true);
  });

  it('skips non-source-extension files', async () => {
    const results = await scanForUsages(tmpDir, ['@aws-sdk/client-s3']);
    const files = results.map((r) => r.file);
    expect(files.every((f) => !f.endsWith('.md'))).toBe(true);
  });

  it('returns line and column numbers', async () => {
    const results = await scanForUsages(tmpDir, ['GetObjectCommand']);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const r = results[0]!;
    expect(r.line).toBeGreaterThan(0);
    expect(r.column).toBeGreaterThan(0);
  });

  it('returns trimmed snippet text', async () => {
    const results = await scanForUsages(tmpDir, ['GetObjectCommand']);
    expect(results[0]?.snippet).toBeTruthy();
  });

  it('returns empty array for a pattern that matches nothing', async () => {
    const results = await scanForUsages(tmpDir, ['nonExistentSymbol_xyz_123']);
    expect(results).toHaveLength(0);
  });

  it('handles a directory that does not exist gracefully', async () => {
    const results = await scanForUsages('/tmp/does-not-exist-abc123', ['anything']);
    expect(results).toHaveLength(0);
  });
});

describe('countImports', () => {
  it('counts distinct files importing a package', async () => {
    const count = await countImports(tmpDir, '@aws-sdk/client-s3');
    // index.ts and utils.ts both import it; node_modules and dist are excluded
    expect(count).toBe(2);
  });

  it('returns 0 when no file imports the package', async () => {
    const count = await countImports(tmpDir, 'some-unknown-package');
    expect(count).toBe(0);
  });
});
