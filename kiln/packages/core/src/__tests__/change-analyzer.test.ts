import { describe, it, expect } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  analyzeChangelog,
  escalateAnalysis,
} from '../change-analyzer.js';

const bedrockMock = mockClient(BedrockRuntimeClient);

// Helper: encode a Bedrock response body
function encodeBedrockResponse(text: string): Uint8Array {
  const body = JSON.stringify({
    content: [{ type: 'text', text }],
  });
  return new TextEncoder().encode(body);
}

const VALID_ANALYSIS = JSON.stringify({
  breakingChanges: [
    {
      description: 'createClient() renamed to createS3Client()',
      apiPattern: 'createClient\\(',
      suggestedPatch: 'createS3Client(',
      requiresHumanReview: false,
    },
    {
      description: 'Credential chain changed — manual review required',
      apiPattern: 'fromIni\\(',
      requiresHumanReview: true,
    },
  ],
  summary: '@aws-sdk/client-s3 v3 — credential + client API overhaul',
});

describe('analyzeChangelog', () => {
  beforeEach(() => {
    bedrockMock.reset();
  });

  it('sends request to Haiku model and parses the response', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBedrockResponse(VALID_ANALYSIS),
    });

    const client = new BedrockRuntimeClient({ region: 'us-west-2' });
    const result = await analyzeChangelog(
      '## v3.0.0\n- createClient renamed\n- credential changes',
      '@aws-sdk/client-s3',
      '2.1.0',
      '3.0.0',
      client,
    );

    expect(result.breakingChanges).toHaveLength(2);
    expect(result.breakingChanges[0]?.requiresHumanReview).toBe(false);
    expect(result.breakingChanges[1]?.requiresHumanReview).toBe(true);
    expect(result.summary).toContain('client-s3');
  });

  it('uses the haiku model id for classification', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBedrockResponse(VALID_ANALYSIS),
    });

    const client = new BedrockRuntimeClient({ region: 'us-west-2' });
    await analyzeChangelog('changelog text', 'react', '18.0.0', '19.0.0', client);

    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.modelId).toBe('anthropic.claude-haiku-4-5');
  });

  it('includes system prompt with cache_control for prompt caching', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBedrockResponse(VALID_ANALYSIS),
    });

    const client = new BedrockRuntimeClient({ region: 'us-west-2' });
    await analyzeChangelog('changelog text', 'react', '18.0.0', '19.0.0', client);

    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    const rawBody = JSON.parse(
      new TextDecoder().decode(calls[0]!.args[0].input.body as Uint8Array),
    ) as { system?: Array<{ cache_control?: { type: string } }> };

    expect(rawBody.system?.[0]?.cache_control?.type).toBe('ephemeral');
  });

  it('returns empty breakingChanges when response JSON is invalid', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBedrockResponse('this is not json at all'),
    });

    const client = new BedrockRuntimeClient({ region: 'us-west-2' });
    const result = await analyzeChangelog('...', 'pkg', '1.0.0', '2.0.0', client);
    expect(result.breakingChanges).toEqual([]);
    expect(result.summary).toContain('Failed');
  });

  it('truncates changelog to 50 kB before sending', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBedrockResponse(VALID_ANALYSIS),
    });

    const hugelog = 'x'.repeat(200_000);
    const client = new BedrockRuntimeClient({ region: 'us-west-2' });
    await analyzeChangelog(hugelog, 'pkg', '1.0.0', '2.0.0', client);

    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    const body = JSON.parse(
      new TextDecoder().decode(calls[0]!.args[0].input.body as Uint8Array),
    ) as { messages: Array<{ content: string }> };

    // The full 200k string should NOT be in the body
    const bodyStr = JSON.stringify(body);
    expect(bodyStr.length).toBeLessThan(200_000);
  });
});

describe('escalateAnalysis', () => {
  beforeEach(() => {
    bedrockMock.reset();
  });

  it('uses the sonnet model id for escalation', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBedrockResponse(VALID_ANALYSIS),
    });

    const client = new BedrockRuntimeClient({ region: 'us-west-2' });
    await escalateAnalysis('changelog', 'prisma', '4.0.0', '5.0.0', client);

    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    expect(calls[0]!.args[0].input.modelId).toBe('anthropic.claude-sonnet-4-6');
  });
});
