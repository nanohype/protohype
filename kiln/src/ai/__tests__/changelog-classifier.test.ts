import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { setBedrockClient } from '../bedrock-client';
import { classifyChangelog, extractBreakingEntries } from '../changelog-classifier';
import { mockUsage } from './test-helpers';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
  setBedrockClient(new BedrockRuntimeClient({ region: 'us-east-1' }));
});

function mockConverseResponse(payload: object) {
  bedrockMock.on(ConverseCommand).resolves({
    output: {
      message: {
        role: 'assistant',
        content: [{ text: JSON.stringify(payload) }],
      },
    },
    usage: mockUsage(200, 50, 160),
  });
}

describe('classifyChangelog', () => {
  it('returns empty result for zero entries without calling Bedrock', async () => {
    const result = await classifyChangelog([]);
    expect(result.entries).toHaveLength(0);
    expect(result.usage.inputTokens).toBe(0);
    expect(bedrockMock).not.toHaveReceivedCommand(ConverseCommand);
  });

  it('classifies entries and returns typed ChangelogEntry objects', async () => {
    mockConverseResponse({
      entries: [
        { type: 'breaking', description: 'S3Client constructor changed', affectedSymbols: ['S3Client'], confidence: 0.95 },
        { type: 'feature', description: 'Added streaming support', affectedSymbols: [], confidence: 0.9 },
        { type: 'fix', description: 'Fixed pagination bug', affectedSymbols: [], confidence: 0.99 },
      ],
    });

    const rawEntries = [
      'BREAKING: S3Client constructor signature changed — region is now required',
      'FEATURE: Added streaming support for large responses',
      'FIX: Fixed pagination token bug in ListObjectsV2',
    ];

    const result = await classifyChangelog(rawEntries);

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]!.type).toBe('breaking');
    expect(result.entries[0]!.affectedSymbols).toContain('S3Client');
    expect(result.entries[1]!.type).toBe('feature');
    expect(result.entries[2]!.type).toBe('fix');
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.cacheReadInputTokens).toBe(160);
  });

  it('handles unknown/invalid type from LLM gracefully', async () => {
    mockConverseResponse({
      entries: [
        { type: 'INVALID_TYPE', description: 'Something happened', affectedSymbols: [], confidence: 0.5 },
      ],
    });

    const result = await classifyChangelog(['some changelog entry']);
    expect(result.entries[0]!.type).toBe('unknown');
  });

  it('clamps confidence to [0,1] range', async () => {
    mockConverseResponse({
      entries: [
        { type: 'breaking', description: 'Changed', affectedSymbols: [], confidence: 1.5 },
        { type: 'fix', description: 'Fixed', affectedSymbols: [], confidence: -0.2 },
      ],
    });

    const result = await classifyChangelog(['entry1', 'entry2']);
    expect(result.entries[0]!.confidence).toBe(1);
    expect(result.entries[1]!.confidence).toBe(0);
  });

  it('throws LLM_PARSE_ERROR when response is not JSON', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: { role: 'assistant', content: [{ text: 'Here is my analysis: blah blah' }] },
      },
      usage: mockUsage(10, 5, 0),
    });

    await expect(classifyChangelog(['some entry'])).rejects.toMatchObject({
      code: 'LLM_PARSE_ERROR',
    });
  });

  it('uses Haiku tier (model ID contains "haiku")', async () => {
    mockConverseResponse({ entries: [{ type: 'fix', description: 'fix', affectedSymbols: [], confidence: 0.9 }] });
    await classifyChangelog(['entry']);
    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input.modelId).toMatch(/haiku/i);
  });

  it('preserves raw text from input', async () => {
    const raw = 'BREAKING: DynamoDB.put() now requires TableName in config';
    mockConverseResponse({
      entries: [{ type: 'breaking', description: 'DynamoDB.put changed', affectedSymbols: ['DynamoDB'], confidence: 0.9 }],
    });

    const result = await classifyChangelog([raw]);
    expect(result.entries[0]!.raw).toBe(raw);
  });
});

describe('extractBreakingEntries', () => {
  it('filters to breaking and security entries only', () => {
    const entries = [
      { raw: '', type: 'breaking' as const, description: '', affectedSymbols: [], confidence: 1 },
      { raw: '', type: 'feature' as const, description: '', affectedSymbols: [], confidence: 1 },
      { raw: '', type: 'security' as const, description: '', affectedSymbols: [], confidence: 1 },
      { raw: '', type: 'fix' as const, description: '', affectedSymbols: [], confidence: 1 },
      { raw: '', type: 'deprecation' as const, description: '', affectedSymbols: [], confidence: 1 },
    ];

    const result = extractBreakingEntries(entries);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.type)).toEqual(['breaking', 'security']);
  });

  it('returns empty array when no breaking/security entries', () => {
    const entries = [
      { raw: '', type: 'feature' as const, description: '', affectedSymbols: [], confidence: 1 },
    ];
    expect(extractBreakingEntries(entries)).toHaveLength(0);
  });
});
