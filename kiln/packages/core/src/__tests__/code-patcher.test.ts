import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join, tmpdir } from 'path';
import { applyFilePatch, dryRunPatch, applyBatchPatches } from '../code-patcher.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kiln-patcher-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeTemp(name: string, content: string): Promise<string> {
  const p = join(tmpDir, name);
  await writeFile(p, content, 'utf-8');
  return p;
}

describe('applyFilePatch', () => {
  it('applies a simple string replacement', async () => {
    const p = await writeTemp('a.ts', "createClient({ region: 'us-east-1' })\n");
    const results = await applyFilePatch(p, [
      {
        pattern: 'createClient',
        replacement: 'createS3Client',
        description: 'rename createClient → createS3Client',
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.originalCode).toBe('createClient');
    expect(results[0]!.patchedCode).toBe('createS3Client');

    const content = await readFile(p, 'utf-8');
    expect(content).toContain('createS3Client');
    expect(content).not.toContain('createClient');
  });

  it('applies a regex replacement with capture groups', async () => {
    const p = await writeTemp('b.ts', "import { foo } from 'old-pkg';\n");
    const results = await applyFilePatch(p, [
      {
        pattern: "from 'old-pkg'",
        replacement: "from 'new-pkg'",
        description: 'rename package',
      },
    ]);

    expect(results[0]!.patchedCode).toBe("from 'new-pkg'");
    const content = await readFile(p, 'utf-8');
    expect(content).toContain("from 'new-pkg'");
  });

  it('returns empty array and does not write when no pattern matches', async () => {
    const original = "const x = 1;\n";
    const p = await writeTemp('c.ts', original);
    const results = await applyFilePatch(p, [
      { pattern: 'nonexistent', replacement: 'replaced', description: 'no-op' },
    ]);

    expect(results).toHaveLength(0);
    const content = await readFile(p, 'utf-8');
    expect(content).toBe(original); // file unchanged
  });

  it('records the 1-based line number of the match', async () => {
    const p = await writeTemp(
      'd.ts',
      'line1\nline2\nline3 createClient\nline4\n',
    );
    const results = await applyFilePatch(p, [
      { pattern: 'createClient', replacement: 'newFn', description: 'rename' },
    ]);

    expect(results[0]!.originalLine).toBe(3);
  });

  it('applies multiple patches in sequence', async () => {
    const p = await writeTemp('e.ts', "foo() and bar()\n");
    const results = await applyFilePatch(p, [
      { pattern: 'foo', replacement: 'FOO', description: 'rename foo' },
      { pattern: 'bar', replacement: 'BAR', description: 'rename bar' },
    ]);

    expect(results).toHaveLength(2);
    const content = await readFile(p, 'utf-8');
    expect(content).toContain('FOO');
    expect(content).toContain('BAR');
  });
});

describe('dryRunPatch', () => {
  it('returns results without modifying the file', async () => {
    const original = "createClient({ region: 'us-east-1' })\n";
    const p = await writeTemp('dry.ts', original);

    const results = await dryRunPatch(p, [
      {
        pattern: 'createClient',
        replacement: 'createS3Client',
        description: 'dry run rename',
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.patchedCode).toBe('createS3Client');

    const content = await readFile(p, 'utf-8');
    expect(content).toBe(original); // unchanged
  });
});

describe('applyBatchPatches', () => {
  it('applies patches across multiple files', async () => {
    const p1 = await writeTemp('f1.ts', "oldFn()\n");
    const p2 = await writeTemp('f2.ts', "oldFn()\noldFn()\n");

    const results = await applyBatchPatches([
      { file: p1, patches: [{ pattern: 'oldFn', replacement: 'newFn', description: 'rename' }] },
      { file: p2, patches: [{ pattern: 'oldFn', replacement: 'newFn', description: 'rename' }] },
    ]);

    expect(results).toHaveLength(3); // 1 in f1, 2 in f2
    const c1 = await readFile(p1, 'utf-8');
    const c2 = await readFile(p2, 'utf-8');
    expect(c1).not.toContain('oldFn');
    expect(c2).not.toContain('oldFn');
  });
});
