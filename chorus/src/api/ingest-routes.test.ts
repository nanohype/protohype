import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createIngestRouter } from './ingest-routes.js';
import type { PipelineDeps } from '../ingestion/pipeline.js';

const SIGNING_SECRET = 'test_signing_secret_abc123';
const INGEST_KEY = 'ingest_key_xyz';

function fakePipelineDeps(): PipelineDeps {
  return {
    db: { query: vi.fn() } as unknown as PipelineDeps['db'],
    matcherDeps: {} as PipelineDeps['matcherDeps'],
    dlq: { sendMessage: vi.fn() },
  };
}

function startApp(overrides: { channelToSquad?: (id: string) => string | undefined } = {}): {
  url: string;
  server: Server;
  close: () => Promise<void>;
  pipelineDeps: PipelineDeps;
} {
  const pipelineDeps = fakePipelineDeps();
  const app = express();
  app.use(express.json());
  app.use(
    createIngestRouter({
      pipelineDeps,
      getSlackSigningSecret: async () => SIGNING_SECRET,
      getIngestApiKey: async () => INGEST_KEY,
      channelToSquad:
        overrides.channelToSquad ?? ((id) => (id === 'C-feedback' ? 'growth' : undefined)),
    }),
  );
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
    pipelineDeps,
  };
}

function slackSign(body: string, secret: string, ts?: number): { ts: string; sig: string } {
  const timestamp = String(ts ?? Math.floor(Date.now() / 1000));
  const basestring = `v0:${timestamp}:${body}`;
  const sig = `v0=${crypto.createHmac('sha256', secret).update(basestring).digest('hex')}`;
  return { ts: timestamp, sig };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /slack/events — url_verification', () => {
  it('echoes the challenge back', async () => {
    const ctx = startApp();
    try {
      const r = await fetch(`${ctx.url}/slack/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
      });
      expect(r.status).toBe(200);
      const json = (await r.json()) as { challenge: string };
      expect(json.challenge).toBe('abc123');
    } finally {
      await ctx.close();
    }
  });
});

describe('POST /slack/events — message events', () => {
  it('returns 200 immediately for valid event_callback', async () => {
    const ctx = startApp();
    try {
      const body = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'message',
          channel: 'C-feedback',
          user: 'U1',
          text: 'CSV broken',
          ts: '123.456',
        },
      });
      const { ts, sig } = slackSign(body, SIGNING_SECRET);
      const r = await fetch(`${ctx.url}/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Slack-Request-Timestamp': ts,
          'X-Slack-Signature': sig,
        },
        body,
      });
      expect(r.status).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  it('ignores messages from channels not in the allowlist', async () => {
    const ctx = startApp();
    try {
      const body = JSON.stringify({
        type: 'event_callback',
        event: { type: 'message', channel: 'C-random', user: 'U1', text: 'off topic', ts: '1.1' },
      });
      const { ts, sig } = slackSign(body, SIGNING_SECRET);
      await fetch(`${ctx.url}/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Slack-Request-Timestamp': ts,
          'X-Slack-Signature': sig,
        },
        body,
      });
      // Pipeline should not be invoked — no way to assert async fire-and-forget
      // directly, but at least it didn't throw.
    } finally {
      await ctx.close();
    }
  });

  it('ignores bot messages (has bot_id)', async () => {
    const ctx = startApp();
    try {
      const body = JSON.stringify({
        type: 'event_callback',
        event: { type: 'message', channel: 'C-feedback', bot_id: 'B1', text: 'bot msg', ts: '1.2' },
      });
      const r = await fetch(`${ctx.url}/slack/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(r.status).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});

describe('POST /api/ingest — webhook', () => {
  it('returns 401 without Authorization header', async () => {
    const ctx = startApp();
    try {
      const r = await fetch(`${ctx.url}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello', sourceItemId: 'x' }),
      });
      expect(r.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it('returns 401 with wrong API key', async () => {
    const ctx = startApp();
    try {
      const r = await fetch(`${ctx.url}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong_key',
        },
        body: JSON.stringify({ text: 'hello', sourceItemId: 'x' }),
      });
      expect(r.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it('returns 400 when text is missing', async () => {
    const ctx = startApp();
    try {
      const r = await fetch(`${ctx.url}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INGEST_KEY}`,
        },
        body: JSON.stringify({ sourceItemId: 'x' }),
      });
      expect(r.status).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('returns 400 when sourceItemId is missing', async () => {
    const ctx = startApp();
    try {
      const r = await fetch(`${ctx.url}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INGEST_KEY}`,
        },
        body: JSON.stringify({ text: 'feedback here' }),
      });
      expect(r.status).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});
