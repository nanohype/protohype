/**
 * Patcher tests.
 * github-app.ts imports jose (ESM-only) — mock it at the module boundary
 * since the patcher unit tests only exercise in-memory logic.
 */
jest.mock('../lambda/shared/github-app', () => ({
  getFileContent: jest.fn(),
  updateFile: jest.fn(),
}));

import { applyPatchesToContent, PatchMismatch } from '../lambda/upgrade-worker/patcher';
import type { CodePatch } from '../lambda/shared/types';

describe('applyPatchesToContent', () => {
  const sampleContent = [
    'import { DynamoDB } from "@aws-sdk/client-dynamodb";',      // line 1
    '',                                                            // line 2
    'const client = new DynamoDB({ region: "us-east-1" });',     // line 3
    '',                                                            // line 4
    'async function putItem() {',                                  // line 5
    '  await client.putItem({ TableName: "t", Item: {} });',      // line 6
    '}',                                                           // line 7
  ].join('\n');

  it('applies a single patch correctly', () => {
    const patch: CodePatch = {
      file: 'src/dynamo.ts',
      startLine: 3,
      endLine: 3,
      original: 'const client = new DynamoDB({ region: "us-east-1" });',
      replacement: 'const client = new DynamoDBClient({ region: "us-east-1" });',
      breakingChangeDescription: 'DynamoDB renamed to DynamoDBClient',
    };

    const result = applyPatchesToContent(sampleContent, [patch]);
    expect(result).toContain('DynamoDBClient');
    expect(result).not.toContain('new DynamoDB(');
  });

  it('applies multiple patches in reverse order', () => {
    const patches: CodePatch[] = [
      {
        file: 'src/dynamo.ts',
        startLine: 1,
        endLine: 1,
        original: 'import { DynamoDB } from "@aws-sdk/client-dynamodb";',
        replacement: 'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";',
        breakingChangeDescription: 'Named export changed',
      },
      {
        file: 'src/dynamo.ts',
        startLine: 3,
        endLine: 3,
        original: 'const client = new DynamoDB({ region: "us-east-1" });',
        replacement: 'const client = new DynamoDBClient({ region: "us-east-1" });',
        breakingChangeDescription: 'DynamoDB renamed to DynamoDBClient',
      },
    ];

    const result = applyPatchesToContent(sampleContent, patches);
    expect(result).toContain('import { DynamoDBClient }');
    expect(result).toContain('new DynamoDBClient');
  });

  it('throws PatchMismatch when original content does not match', () => {
    const patch: CodePatch = {
      file: 'src/dynamo.ts',
      startLine: 1,
      endLine: 1,
      original: 'this is not in the file',
      replacement: 'something else',
      breakingChangeDescription: 'test',
    };

    expect(() => applyPatchesToContent(sampleContent, [patch])).toThrow(PatchMismatch);
  });

  it('throws PatchMismatch for out-of-bounds line number', () => {
    const patch: CodePatch = {
      file: 'src/dynamo.ts',
      startLine: 999,
      endLine: 999,
      original: 'something',
      replacement: 'something else',
      breakingChangeDescription: 'test',
    };

    expect(() => applyPatchesToContent(sampleContent, [patch])).toThrow(PatchMismatch);
  });

  it('handles multi-line patch replacement', () => {
    const patch: CodePatch = {
      file: 'src/dynamo.ts',
      startLine: 5,
      endLine: 7,
      original: 'async function putItem() {\n  await client.putItem({ TableName: "t", Item: {} });\n}',
      replacement: 'async function putItem() {\n  const cmd = new PutItemCommand({ TableName: "t", Item: {} });\n  await client.send(cmd);\n}',
      breakingChangeDescription: 'putItem migrated to command pattern',
    };

    const result = applyPatchesToContent(sampleContent, [patch]);
    expect(result).toContain('PutItemCommand');
    expect(result).toContain('client.send(cmd)');
  });

  it('returns original content unchanged if patches array is empty', () => {
    const result = applyPatchesToContent(sampleContent, []);
    expect(result).toBe(sampleContent);
  });

  it('PatchMismatch has the correct properties', () => {
    const patch: CodePatch = {
      file: 'src/test.ts',
      startLine: 1,
      endLine: 1,
      original: 'wrong content',
      replacement: 'new content',
      breakingChangeDescription: 'test',
    };

    let error: PatchMismatch | null = null;
    try {
      applyPatchesToContent('actual content\nline 2', [patch]);
    } catch (e) {
      error = e as PatchMismatch;
    }

    expect(error).not.toBeNull();
    expect(error!.file).toBe('src/test.ts');
    expect(error!.line).toBe(1);
  });
});
