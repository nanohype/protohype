import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  postWeeklyDigest,
  fetchWeeklyStats,
  fetchPendingForSquads,
  type DigestSlackClient,
  type WeeklyDigestDeps,
} from './weekly-digest.js';
import type { DirectoryUserRecord } from '../lib/directory.js';
import type { Pool } from 'pg';

function makeDb(...responses: Array<{ rows: unknown[] }>): Pool {
  const queryMock = vi.fn();
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
  return { query: queryMock } as unknown as Pool;
}

function makeSlack(): DigestSlackClient {
  return {
    postMessage: vi.fn(async () => undefined),
    sendDm: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchWeeklyStats', () => {
  it('aggregates totals and the top-3 backlog entries with parsed counts', async () => {
    const db = makeDb(
      { rows: [{ total: '12', link_count: '8', new_count: '4' }] },
      {
        rows: [
          { linear_id: 'pb-1', title: 'CSV exports', evidence_count: '5' },
          { linear_id: 'pb-2', title: 'Webhooks', evidence_count: '3' },
        ],
      },
    );
    const stats = await fetchWeeklyStats(db);
    expect(stats.totalProposed).toBe(12);
    expect(stats.linkCount).toBe(8);
    expect(stats.newCount).toBe(4);
    expect(stats.topBacklogEntries).toHaveLength(2);
    expect(stats.topBacklogEntries[0]?.evidenceCount).toBe(5);
  });

  it('returns zeros when the totals row is absent', async () => {
    const db = makeDb({ rows: [] }, { rows: [] });
    const stats = await fetchWeeklyStats(db);
    expect(stats.totalProposed).toBe(0);
    expect(stats.linkCount).toBe(0);
    expect(stats.newCount).toBe(0);
  });
});

describe('fetchPendingForSquads', () => {
  it('applies the SQL ACL filter raw_evidence.acl_squad_ids && $1::text[]', async () => {
    const db = makeDb({ rows: [] });
    await fetchPendingForSquads(db, ['growth', 'billing']);
    const call = (db.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toContain('acl_squad_ids && $1::text[]');
    expect(call?.[1]).toEqual([['growth', 'billing'], 5]);
  });

  it('short-circuits to [] when no squads are provided', async () => {
    const db = makeDb();
    const r = await fetchPendingForSquads(db, []);
    expect(r).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns mapped rows with snippet truncated to 120 chars', async () => {
    const long = 'a'.repeat(200);
    const db = makeDb({
      rows: [
        {
          id: 'fi-1',
          proposed_at: new Date('2026-04-01T12:00:00Z'),
          source: 'slack',
          redacted_text: long,
        },
      ],
    });
    const r = await fetchPendingForSquads(db, ['growth']);
    expect(r[0]?.redactedTextSnippet).toHaveLength(120);
    expect(r[0]?.id).toBe('fi-1');
  });
});

describe('postWeeklyDigest', () => {
  function makeDeps(
    pms: DirectoryUserRecord[],
    db: Pool = makeDb({ rows: [{ total: '0', link_count: '0', new_count: '0' }] }, { rows: [] }),
  ): WeeklyDigestDeps {
    return {
      db,
      slack: makeSlack(),
      channel: '#product-feedback',
      reviewBaseUrl: 'https://chorus.example.com',
      listPms: async () => pms,
    };
  }

  it('posts to the channel with the formatted weekly stats', async () => {
    const deps = makeDeps([]);
    await postWeeklyDigest(deps);
    expect(deps.slack.postMessage).toHaveBeenCalledOnce();
    const call = (deps.slack.postMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toMatchObject({ channel: '#product-feedback' });
    expect((call?.[0] as { text: string }).text).toContain('Weekly chorus digest');
  });

  it('skips PMs without a slackUserId or without squad ACLs', async () => {
    const pms: DirectoryUserRecord[] = [
      { sub: 'u1', email: 'no-slack@x.com', squadIds: ['growth'] }, // no slackUserId
      { sub: 'u2', email: 'no-squads@x.com', squadIds: [], slackUserId: 'U2' },
    ];
    const deps = makeDeps(pms);
    const r = await postWeeklyDigest(deps);
    expect(r.dmsSent).toBe(0);
    expect(deps.slack.sendDm).not.toHaveBeenCalled();
  });

  it('DMs each eligible PM with their pending proposals, deep-linked to the review UI', async () => {
    const db = makeDb(
      // fetchWeeklyStats — totals + top backlog
      { rows: [{ total: '3', link_count: '2', new_count: '1' }] },
      { rows: [] },
      // fetchPendingForSquads for first PM
      {
        rows: [
          {
            id: 'fi-1',
            proposed_at: new Date(Date.now() - 36 * 60 * 60 * 1000),
            source: 'slack',
            redacted_text: 'CSV exports broken',
          },
        ],
      },
    );
    const pms: DirectoryUserRecord[] = [
      { sub: 'u-alice', email: 'alice@x.com', squadIds: ['growth'], slackUserId: 'U_ALICE' },
    ];
    const deps = makeDeps(pms, db);
    const r = await postWeeklyDigest(deps);
    expect(r.dmsSent).toBe(1);
    const dmCall = (deps.slack.sendDm as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(dmCall?.[0]).toMatchObject({ userId: 'U_ALICE' });
    const text = (dmCall?.[0] as { text: string }).text;
    expect(text).toContain('CSV exports broken');
    expect(text).toContain('https://chorus.example.com/proposals/fi-1');
    expect(text).toMatch(/1d old/);
  });

  it('continues sending DMs when one PM DM fails', async () => {
    const db = makeDb(
      { rows: [{ total: '1', link_count: '1', new_count: '0' }] },
      { rows: [] },
      // first PM pending
      {
        rows: [
          {
            id: 'fi-a',
            proposed_at: new Date(),
            source: 'slack',
            redacted_text: 'a',
          },
        ],
      },
      // second PM pending
      {
        rows: [
          {
            id: 'fi-b',
            proposed_at: new Date(),
            source: 'webhook',
            redacted_text: 'b',
          },
        ],
      },
    );
    const slack = makeSlack();
    (slack.sendDm as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Slack 503'))
      .mockResolvedValueOnce(undefined);
    const pms: DirectoryUserRecord[] = [
      { sub: 'u1', email: '1@x.com', squadIds: ['growth'], slackUserId: 'U1' },
      { sub: 'u2', email: '2@x.com', squadIds: ['billing'], slackUserId: 'U2' },
    ];
    const deps: WeeklyDigestDeps = {
      db,
      slack,
      channel: '#product-feedback',
      reviewBaseUrl: 'https://chorus.example.com',
      listPms: async () => pms,
    };
    const r = await postWeeklyDigest(deps);
    expect(r.dmsSent).toBe(1);
    expect(slack.sendDm).toHaveBeenCalledTimes(2);
  });
});
