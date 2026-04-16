/**
 * Title-generator service tests with Bedrock injected as a port.
 */
import { describe, it, expect, vi } from 'vitest';
import type { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { createTitleGenerator } from './title-generator.js';
import type { BedrockPort } from './embedder.js';
import { asRedactedForTests } from './redacted-text.js';

function bedrockSaying(text: string | null): BedrockPort {
  const body = text === null ? { content: [] } : { content: [{ text }] };
  return {
    send: vi.fn(async (_cmd: InvokeModelCommand) => ({
      body: new TextEncoder().encode(JSON.stringify(body)),
    })),
  };
}

describe('createTitleGenerator', () => {
  it('returns the trimmed Claude response text', async () => {
    const t = createTitleGenerator({ bedrock: bedrockSaying('  Adding CSV exports  ') });
    expect(await t(asRedactedForTests('want exports'))).toBe('Adding CSV exports');
  });

  it('strips leading/trailing single and double quotes (Claude often wraps the title)', async () => {
    const t1 = createTitleGenerator({ bedrock: bedrockSaying('"Improving search relevance"') });
    expect(await t1(asRedactedForTests('search bad'))).toBe('Improving search relevance');
    const t2 = createTitleGenerator({ bedrock: bedrockSaying("'Refactoring billing code'") });
    expect(await t2(asRedactedForTests('billing slow'))).toBe('Refactoring billing code');
  });

  it('falls back to "Untitled feature request" when Bedrock returns no content', async () => {
    const t = createTitleGenerator({ bedrock: bedrockSaying(null) });
    expect(await t(asRedactedForTests('text'))).toBe('Untitled feature request');
  });

  it('truncates the feedback text in the prompt at 1000 chars', async () => {
    const bedrock = bedrockSaying('Title');
    const t = createTitleGenerator({ bedrock });
    const long = 'a'.repeat(2000);
    await t(asRedactedForTests(long));
    const sendMock = bedrock.send as ReturnType<typeof vi.fn>;
    const cmd = sendMock.mock.calls[0]?.[0] as { input: { body: string } };
    const payload = JSON.parse(cmd.input.body) as {
      messages: Array<{ content: string }>;
    };
    expect(payload.messages[0]?.content).toContain('a'.repeat(1000));
    expect(payload.messages[0]?.content).not.toContain('a'.repeat(1001));
  });

  it('uses the configured modelId on the InvokeModelCommand', async () => {
    const bedrock = bedrockSaying('T');
    const t = createTitleGenerator({ bedrock, modelId: 'custom-haiku' });
    await t(asRedactedForTests('text'));
    const sendMock = bedrock.send as ReturnType<typeof vi.fn>;
    const cmd = sendMock.mock.calls[0]?.[0] as { input: { modelId: string } };
    expect(cmd.input.modelId).toBe('custom-haiku');
  });
});
