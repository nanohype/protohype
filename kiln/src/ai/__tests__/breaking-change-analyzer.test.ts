import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { setBedrockClient } from '../bedrock-client';
import { analyzeBreakingChanges } from '../breaking-change-analyzer';
import type { ChangelogEntry, CodebaseFile } from '../types';
import { mockUsage } from './test-helpers';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
  setBedrockClient(new BedrockRuntimeClient({ region: 'us-east-1' }));
});

const s3BreakingEntry: ChangelogEntry = {
  raw: 'BREAKING: S3Client now requires explicit region configuration',
  type: 'breaking',
  description: 'S3Client constructor requires region parameter',
  affectedSymbols: ['S3Client', 'new S3Client'],
  confidence: 0.95,
};

const testFile: CodebaseFile = {
  filePath: 'src/services/storage.ts',
  content: `import { S3Client } from '@aws-sdk/client-s3';
const client = new S3Client({});
export { client };`,
};

function mockAnalyzerResponse(affected: object[]) {
  bedrockMock.on(ConverseCommand).resolves({
    output: {
      message: {
        role: 'assistant',
        content: [{ text: JSON.stringify({ affected }) }],
      },
    },
    usage: mockUsage(300, 80, 240),
  });
}

describe('analyzeBreakingChanges', () => {
  it('returns empty result when no breaking entries', async () => {
    const result = await analyzeBreakingChanges([], [testFile]);
    expect(result.affectedUsages).toHaveLength(0);
    expect(bedrockMock).not.toHaveReceivedCommand(ConverseCommand);
  });

  it('returns empty result when no files', async () => {
    const result = await analyzeBreakingChanges([s3BreakingEntry], []);
    expect(result.affectedUsages).toHaveLength(0);
    expect(bedrockMock).not.toHaveReceivedCommand(ConverseCommand);
  });

  it('maps LLM findings to AffectedUsage objects', async () => {
    mockAnalyzerResponse([
      {
        filePath: 'src/services/storage.ts',
        lineNumber: 2,
        lineContent: "const client = new S3Client({});",
        changelogEntryIndex: 0,
        patchStrategy: 'mechanical',
        patchStrategyReason: 'Simple constructor argument addition',
      },
    ]);

    const result = await analyzeBreakingChanges([s3BreakingEntry], [testFile]);

    expect(result.affectedUsages).toHaveLength(1);
    const usage = result.affectedUsages[0]!;
    expect(usage.filePath).toBe('src/services/storage.ts');
    expect(usage.lineNumber).toBe(2);
    expect(usage.patchStrategy).toBe('mechanical');
    expect(usage.changelogEntry).toBe(s3BreakingEntry);
  });

  it('maps human-review strategy correctly', async () => {
    mockAnalyzerResponse([
      {
        filePath: 'src/services/storage.ts',
        lineNumber: 2,
        lineContent: "const client = new S3Client({});",
        changelogEntryIndex: 0,
        patchStrategy: 'human-review',
        patchStrategyReason: 'Dynamic region selection requires business logic review',
      },
    ]);

    const result = await analyzeBreakingChanges([s3BreakingEntry], [testFile]);
    expect(result.affectedUsages[0]!.patchStrategy).toBe('human-review');
  });

  it('returns empty affected when LLM finds no matches', async () => {
    mockAnalyzerResponse([]);
    const result = await analyzeBreakingChanges([s3BreakingEntry], [testFile]);
    expect(result.affectedUsages).toHaveLength(0);
  });

  it('uses Sonnet tier (model ID contains "sonnet")', async () => {
    mockAnalyzerResponse([]);
    await analyzeBreakingChanges([s3BreakingEntry], [testFile]);
    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input.modelId).toMatch(/sonnet/i);
  });

  it('throws LLM_PARSE_ERROR on invalid JSON response', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: { role: 'assistant', content: [{ text: 'invalid json output' }] },
      },
      usage: mockUsage(10, 5, 0),
    });

    await expect(analyzeBreakingChanges([s3BreakingEntry], [testFile])).rejects.toMatchObject({
      code: 'LLM_PARSE_ERROR',
    });
  });

  it('accumulates usage across multiple file batches', async () => {
    // Create files that exceed the batch limit to force multiple calls
    const largeFiles: CodebaseFile[] = Array.from({ length: 3 }, (_, i) => ({
      filePath: `src/file${i}.ts`,
      content: 'x'.repeat(40_000), // 40k chars each, 80k limit = 2 batches
    }));

    bedrockMock.on(ConverseCommand)
      .resolvesOnce({
        output: { message: { role: 'assistant', content: [{ text: '{"affected":[]}' }] } },
        usage: mockUsage(100, 10, 80),
      })
      .resolvesOnce({
        output: { message: { role: 'assistant', content: [{ text: '{"affected":[]}' }] } },
        usage: mockUsage(100, 10, 80),
      });

    const result = await analyzeBreakingChanges([s3BreakingEntry], largeFiles);
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.cacheReadInputTokens).toBe(160);
  });
});
