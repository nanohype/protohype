import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { setBedrockClient } from '../bedrock-client';
import { synthesizeMigration } from '../migration-synthesizer';
import type { AffectedUsage, ChangelogEntry } from '../types';
import { mockUsage } from './test-helpers';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
  setBedrockClient(new BedrockRuntimeClient({ region: 'us-east-1' }));
});

const breakingEntry: ChangelogEntry = {
  raw: 'BREAKING: S3Client region is now required',
  type: 'breaking',
  description: 'S3Client constructor requires explicit region',
  affectedSymbols: ['S3Client'],
  confidence: 0.95,
};

const mechanicalUsage: AffectedUsage = {
  filePath: 'src/services/storage.ts',
  lineNumber: 2,
  lineContent: "const client = new S3Client({});",
  changelogEntry: breakingEntry,
  patchStrategy: 'mechanical',
  patchStrategyReason: 'Add region field to constructor argument',
};

const reviewUsage: AffectedUsage = {
  filePath: 'src/services/dynamic.ts',
  lineNumber: 10,
  lineContent: "const client = new S3Client(getConfig());",
  changelogEntry: breakingEntry,
  patchStrategy: 'human-review',
  patchStrategyReason: 'Dynamic config — region must be verified at runtime',
};

function mockMechanicalResponse() {
  bedrockMock.on(ConverseCommand).resolvesOnce({
    output: {
      message: {
        role: 'assistant',
        content: [{
          text: JSON.stringify({
            patches: [{
              filePath: 'src/services/storage.ts',
              lineNumber: 2,
              originalLine: "const client = new S3Client({});",
              patchedLine: "const client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });",
              explanation: 'Added explicit region to satisfy @aws-sdk/client-s3 v3 requirement',
              complexityScore: 2,
            }],
          }),
        }],
      },
    },
    usage: mockUsage(400, 100, 300),
  });
}

function mockReviewResponse() {
  bedrockMock.on(ConverseCommand).resolvesOnce({
    output: {
      message: {
        role: 'assistant',
        content: [{
          text: JSON.stringify({
            cases: [{
              filePath: 'src/services/dynamic.ts',
              lineNumber: 10,
              lineContent: "const client = new S3Client(getConfig());",
              reason: 'Dynamic config function may not include region',
              suggestedAction: 'Ensure getConfig() returns an object with a region property set to a valid AWS region.',
            }],
          }),
        }],
      },
    },
    usage: mockUsage(200, 60, 150),
  });
}

describe('synthesizeMigration', () => {
  it('returns empty result for no usages', async () => {
    const result = await synthesizeMigration([]);
    expect(result.patches).toHaveLength(0);
    expect(result.humanReviewCases).toHaveLength(0);
    expect(bedrockMock).not.toHaveReceivedCommand(ConverseCommand);
  });

  it('generates patches for mechanical usages', async () => {
    mockMechanicalResponse();

    const result = await synthesizeMigration([mechanicalUsage]);

    expect(result.patches).toHaveLength(1);
    const patch = result.patches[0]!;
    expect(patch.filePath).toBe('src/services/storage.ts');
    expect(patch.lineNumber).toBe(2);
    expect(patch.originalLine).toBe("const client = new S3Client({});");
    expect(patch.patchedLine).toContain('region');
    expect(patch.explanation).toContain('region');
    expect(patch.sourceEntry).toBe(breakingEntry);
  });

  it('generates human-review cases for review usages', async () => {
    mockReviewResponse();

    const result = await synthesizeMigration([reviewUsage]);

    expect(result.humanReviewCases).toHaveLength(1);
    const review = result.humanReviewCases[0]!;
    expect(review.filePath).toBe('src/services/dynamic.ts');
    expect(review.lineNumber).toBe(10);
    expect(review.reason).toBeTruthy();
    expect(review.suggestedAction).toBeTruthy();
    expect(review.sourceEntry).toBe(breakingEntry);
  });

  it('handles both mechanical and review usages in same call', async () => {
    mockMechanicalResponse();
    mockReviewResponse();

    const result = await synthesizeMigration([mechanicalUsage, reviewUsage]);

    expect(result.patches).toHaveLength(1);
    expect(result.humanReviewCases).toHaveLength(1);
    expect(bedrockMock).toHaveReceivedCommandTimes(ConverseCommand, 2);
  });

  it('accumulates usage from both calls', async () => {
    mockMechanicalResponse();
    mockReviewResponse();

    const result = await synthesizeMigration([mechanicalUsage, reviewUsage]);
    expect(result.usage.inputTokens).toBe(600);
    expect(result.usage.cacheReadInputTokens).toBe(450);
  });

  it('uses Sonnet for low-complexity usages', async () => {
    mockMechanicalResponse();
    await synthesizeMigration([mechanicalUsage]);
    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input.modelId).toMatch(/sonnet/i);
  });

  it('throws LLM_PARSE_ERROR on invalid JSON for mechanical patches', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: { role: 'assistant', content: [{ text: 'not json' }] },
      },
      usage: mockUsage(10, 5, 0),
    });

    await expect(synthesizeMigration([mechanicalUsage])).rejects.toMatchObject({
      code: 'LLM_PARSE_ERROR',
    });
  });
});
