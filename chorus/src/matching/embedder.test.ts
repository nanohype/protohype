/**
 * Embedder service tests with Bedrock injected as a port. No
 * `vi.mock('@aws-sdk/client-bedrock-runtime')`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { createEmbedder, type BedrockPort } from './embedder.js';
import { asRedactedForTests } from './redacted-text.js';
import type { AuditPort, AuditLogEntry } from '../lib/audit.js';

function bedrockReturning(...embeddings: number[][]): BedrockPort {
  let i = 0;
  return {
    send: vi.fn(async (_cmd: InvokeModelCommand) => {
      const next = embeddings[Math.min(i, embeddings.length - 1)];
      i++;
      const payload = JSON.stringify({ embedding: next });
      return { body: new TextEncoder().encode(payload) };
    }),
  };
}

function recordingAudit(): { audit: AuditPort; calls: AuditLogEntry[] } {
  const calls: AuditLogEntry[] = [];
  return { audit: async (entry) => void calls.push(entry), calls };
}

describe('createEmbedder.embedSingle', () => {
  it('invokes Bedrock with a JSON body containing inputText, dimensions, normalize', async () => {
    const bedrock = bedrockReturning(new Array<number>(1024).fill(0.1));
    const { audit } = recordingAudit();
    const e = createEmbedder({ bedrock, audit });
    const v = await e.embedSingle('corr-1', asRedactedForTests('hello'));
    expect(v).toHaveLength(1024);
    const sendMock = bedrock.send as ReturnType<typeof vi.fn>;
    const cmd = sendMock.mock.calls[0]?.[0] as { input: { body?: string } };
    const body = JSON.parse(cmd.input.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ inputText: 'hello', dimensions: 1024, normalize: true });
  });

  it('audits one EMBED row carrying modelId and dimension', async () => {
    const bedrock = bedrockReturning([0.1, 0.2, 0.3]);
    const { audit, calls } = recordingAudit();
    const e = createEmbedder({ bedrock, audit, modelId: 'test-model' });
    await e.embedSingle('corr-2', asRedactedForTests('text'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      correlationId: 'corr-2',
      stage: 'EMBED',
      detail: { modelId: 'test-model', dim: 3 },
    });
  });

  it('throws on a malformed Bedrock body (not an array of numbers)', async () => {
    const bedrock: BedrockPort = {
      send: vi.fn(async () => ({
        body: new TextEncoder().encode(JSON.stringify({ embedding: 'not-an-array' })),
      })),
    };
    const { audit } = recordingAudit();
    const e = createEmbedder({ bedrock, audit });
    await expect(e.embedSingle('c', asRedactedForTests('t'))).rejects.toThrow(/Bedrock response/);
  });
});

describe('createEmbedder.embedBatch', () => {
  it('emits one EmbeddingResult per text, each carrying the original RedactedText and embedding', async () => {
    const bedrock = bedrockReturning([0.1, 0.2], [0.3, 0.4]);
    const { audit, calls } = recordingAudit();
    const e = createEmbedder({ bedrock, audit });
    const r = await e.embedBatch(['c1', 'c2'], [asRedactedForTests('a'), asRedactedForTests('b')]);
    expect(r).toEqual([
      { text: 'a', embedding: [0.1, 0.2] },
      { text: 'b', embedding: [0.3, 0.4] },
    ]);
    expect(calls.map((c) => c.correlationId)).toEqual(['c1', 'c2']);
  });

  it('skips entries when text/embedding/id is undefined (mismatched arrays)', async () => {
    const bedrock = bedrockReturning([0.1]);
    const { audit, calls } = recordingAudit();
    const e = createEmbedder({ bedrock, audit });
    const r = await e.embedBatch(['c1'], [asRedactedForTests('one')]);
    expect(r).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('processes inputs in chunks of `batchSize` (sequential, not parallel across batches)', async () => {
    const sendOrder: number[] = [];
    const bedrock: BedrockPort = {
      send: vi.fn(async () => {
        sendOrder.push(sendOrder.length);
        return { body: new TextEncoder().encode(JSON.stringify({ embedding: [0] })) };
      }),
    };
    const { audit } = recordingAudit();
    const e = createEmbedder({ bedrock, audit, batchSize: 2 });
    const texts = ['a', 'b', 'c'].map(asRedactedForTests);
    await e.embedBatch(['c1', 'c2', 'c3'], texts);
    expect(sendOrder).toEqual([0, 1, 2]);
  });
});
