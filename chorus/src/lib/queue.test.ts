import { describe, it, expect, vi } from 'vitest';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createDlqClient, type SqsPort } from './queue.js';

describe('createDlqClient — no DLQ_URL fallback', () => {
  it('writes a JSON line carrying the message + _dlq:true via the injected logger', async () => {
    const lines: string[] = [];
    const client = createDlqClient({ dlqUrl: undefined, logger: (l) => lines.push(l) });
    await client.sendMessage({
      correlationId: 'c-1',
      stage: 'PIPELINE',
      source: 'slack',
      sourceItemId: 'C-1:42',
      error: 'boom',
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['correlationId']).toBe('c-1');
    expect(parsed['_dlq']).toBe(true);
    expect(parsed['error']).toBe('boom');
  });
});

describe('createDlqClient — SQS path', () => {
  it('sends a SendMessageCommand to the configured queue with JSON-encoded body', async () => {
    const send = vi.fn<(c: SendMessageCommand) => Promise<unknown>>(async () => undefined);
    const sqs: SqsPort = { send };
    const client = createDlqClient({
      sqs,
      dlqUrl: 'https://sqs.us-east-1.amazonaws.com/123/dlq',
    });
    await client.sendMessage({
      correlationId: 'c-2',
      stage: 'PIPELINE',
      source: 'webhook',
      sourceItemId: '17',
      error: 'oops',
    });
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0];
    expect(cmd.input.QueueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123/dlq');
    const body = JSON.parse(cmd.input.MessageBody ?? '{}') as Record<string, unknown>;
    expect(body['correlationId']).toBe('c-2');
    expect(body['source']).toBe('webhook');
    expect(typeof body['timestamp']).toBe('string');
  });

  it('uses the message timestamp when provided; otherwise from `now`', async () => {
    const send = vi.fn<(c: SendMessageCommand) => Promise<unknown>>(async () => undefined);
    const fixed = new Date('2026-04-01T00:00:00.000Z');
    const client = createDlqClient({
      sqs: { send },
      dlqUrl: 'q',
      now: () => fixed,
    });
    await client.sendMessage({
      correlationId: 'c',
      stage: 'PIPELINE',
      error: 'e',
      timestamp: '2025-01-01T00:00:00Z',
    });
    let body = JSON.parse(send.mock.calls[0]![0].input.MessageBody ?? '{}') as Record<
      string,
      unknown
    >;
    expect(body['timestamp']).toBe('2025-01-01T00:00:00Z');

    await client.sendMessage({ correlationId: 'c', stage: 'PIPELINE', error: 'e' });
    body = JSON.parse(send.mock.calls[1]![0].input.MessageBody ?? '{}') as Record<string, unknown>;
    expect(body['timestamp']).toBe('2026-04-01T00:00:00.000Z');
  });

  it('propagates SQS errors so the caller sees the failure', async () => {
    const send = vi.fn(async () => {
      throw new Error('sqs throttled');
    });
    const client = createDlqClient({ sqs: { send }, dlqUrl: 'q' });
    await expect(
      client.sendMessage({ correlationId: 'c', stage: 'PIPELINE', error: 'e' }),
    ).rejects.toThrow('sqs throttled');
  });
});
