import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  getBedrockClient,
  setBedrockClient,
  converse,
  addUsage,
  cacheHitRatio,
  extractJson,
  zeroUsage,
  withSystemCachePoint,
} from '../bedrock-client';

const bedrockMock = mockClient(BedrockRuntimeClient);

function mockUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheWriteInputTokens = 0,
) {
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens, totalTokens: inputTokens + outputTokens };
}

beforeEach(() => {
  bedrockMock.reset();
  // Reset singleton between tests
  setBedrockClient(new BedrockRuntimeClient({ region: 'us-east-1' }));
});

describe('getBedrockClient', () => {
  it('returns the injected client', () => {
    const client = new BedrockRuntimeClient({ region: 'us-west-2' });
    setBedrockClient(client);
    expect(getBedrockClient()).toBe(client);
  });
});

describe('converse', () => {
  it('returns text and usage from a successful response', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: '{"result":"ok"}' }],
        },
      },
      usage: mockUsage(100, 20, 80),
    });

    const result = await converse({
      tier: 'default',
      system: withSystemCachePoint('You are helpful.'),
      messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
    });

    expect(result.text).toBe('{"result":"ok"}');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.cacheReadInputTokens).toBe(80);
    expect(bedrockMock).toHaveReceivedCommandTimes(ConverseCommand, 1);
  });

  it('uses the correct model ID for each tier', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [{ text: '{}' }] } },
      usage: mockUsage(10, 5, 0),
    });

    for (const tier of ['classify', 'default', 'complex'] as const) {
      await converse({
        tier,
        system: [{ text: 'sys' }],
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      });
    }

    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input.modelId).toMatch(/haiku/i);
    expect(calls[1]?.args[0].input.modelId).toMatch(/sonnet/i);
    expect(calls[2]?.args[0].input.modelId).toMatch(/opus/i);
  });

  it('throws when the underlying send call rejects', async () => {
    const client = new BedrockRuntimeClient({ region: 'us-east-1' });
    const spy = jest.spyOn(client, 'send').mockRejectedValue(new Error('Network error'));
    setBedrockClient(client);

    await expect(
      converse({
        tier: 'default',
        system: [{ text: 'sys' }],
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      }),
    ).rejects.toThrow('Network error');

    spy.mockRestore();
    setBedrockClient(new BedrockRuntimeClient({ region: 'us-east-1' }));
  });

  it('handles missing usage fields gracefully', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });

    const result = await converse({
      tier: 'classify',
      system: [{ text: 'sys' }],
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    });

    expect(result.usage).toEqual(zeroUsage());
  });
});

describe('addUsage', () => {
  it('sums all token fields', () => {
    const a = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 8, cacheWriteInputTokens: 2 };
    const b = { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 15, cacheWriteInputTokens: 3 };
    expect(addUsage(a, b)).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      cacheReadInputTokens: 23,
      cacheWriteInputTokens: 5,
    });
  });
});

describe('cacheHitRatio', () => {
  it('returns cacheRead / (input + cacheRead)', () => {
    const usage = { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 80, cacheWriteInputTokens: 0 };
    expect(cacheHitRatio(usage)).toBeCloseTo(0.8);
  });

  it('returns 0 when no tokens have been used', () => {
    expect(cacheHitRatio(zeroUsage())).toBe(0);
  });
});

describe('extractJson', () => {
  it('parses plain JSON', () => {
    const result = extractJson<{ x: number }>('{"x":1}');
    expect(result.x).toBe(1);
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"x":2}\n```';
    expect(extractJson<{ x: number }>(raw).x).toBe(2);
  });

  it('extracts JSON from text with preamble', () => {
    const raw = 'Here is the result:\n{"entries":[]}';
    expect(extractJson<{ entries: unknown[] }>(raw).entries).toEqual([]);
  });

  it('throws on unparseable input', () => {
    expect(() => extractJson('not json at all')).toThrow(/no parseable JSON/);
  });
});

describe('withSystemCachePoint', () => {
  it('produces array with text block and cache point', () => {
    const result = withSystemCachePoint('System prompt');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ text: 'System prompt' });
    expect(result[1]).toHaveProperty('cachePoint');
  });
});
