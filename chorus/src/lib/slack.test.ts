import { describe, it, expect, vi } from 'vitest';
import { createSlackClient } from './slack.js';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SlackClient.postMessage', () => {
  it('POSTs to /api/chat.postMessage with channel + text + unfurl_links:false; sends Bearer auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ ok: true }));
    const client = createSlackClient({ getApiToken: async () => 'xoxb-test', fetchImpl });
    await client.postMessage({ channel: '#a', text: 'hi', correlationId: 'c-1' });
    const call = fetchImpl.mock.calls[0]!;
    expect(String(call[0])).toBe('https://slack.com/api/chat.postMessage');
    expect((call[1]?.headers as Record<string, string>)['Authorization']).toBe('Bearer xoxb-test');
    const body = JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ channel: '#a', text: 'hi', unfurl_links: false });
  });

  it('throws when Slack returns ok:false', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ok({ ok: false, error: 'channel_not_found' }),
    );
    const client = createSlackClient({ getApiToken: async () => 't', fetchImpl });
    await expect(client.postMessage({ channel: '#x', text: 'y' })).rejects.toThrow(
      /channel_not_found/,
    );
  });
});

describe('SlackClient.sendDm', () => {
  it('opens a DM channel then posts the text into it', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ ok: true, channel: { id: 'D-99' } }))
      .mockResolvedValueOnce(ok({ ok: true }));
    const client = createSlackClient({ getApiToken: async () => 't', fetchImpl });
    await client.sendDm({ userId: 'U-1', text: 'hi', correlationId: 'c' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://slack.com/api/conversations.open');
    const openBody = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as {
      users: string;
    };
    expect(openBody.users).toBe('U-1');

    expect(String(fetchImpl.mock.calls[1]![0])).toBe('https://slack.com/api/chat.postMessage');
    const postBody = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)) as {
      channel: string;
      text: string;
    };
    expect(postBody).toMatchObject({ channel: 'D-99', text: 'hi' });
  });

  it('returns silently when conversations.open responds ok:false (no postMessage attempted)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ ok: false, error: 'cannot_dm_bot' }));
    const client = createSlackClient({ getApiToken: async () => 't', fetchImpl });
    await client.sendDm({ userId: 'U-1', text: 'hi' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns silently when conversations.open responds without a channel', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok({ ok: true }));
    const client = createSlackClient({ getApiToken: async () => 't', fetchImpl });
    await client.sendDm({ userId: 'U-1', text: 'hi' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
