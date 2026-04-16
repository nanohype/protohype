import { describe, it, expect, vi } from 'vitest';
import { createLinearSync } from './linear-sync.js';
import type { Pool } from 'pg';
import type { AuditPort, AuditLogEntry } from '../lib/audit.js';
import type { RedactedText } from '../matching/redacted-text.js';

function gql(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeDb(): { db: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { db: { query } as unknown as Pool, query };
}

function recordingAudit(): { audit: AuditPort; calls: AuditLogEntry[] } {
  const calls: AuditLogEntry[] = [];
  return { audit: async (entry) => void calls.push(entry), calls };
}

const BASE = 'https://api.linear.test';
const TEAM = 'team_01';

describe('LinearSync.mirror', () => {
  it('paginates issues and upserts each into backlog_entries', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        gql({
          data: {
            issues: {
              nodes: [
                { id: 'iss-1', title: 'CSV exports', description: 'Allow CSV' },
                { id: 'iss-2', title: 'Webhooks', description: null },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'cursor_page2' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        gql({
          data: {
            issues: {
              nodes: [{ id: 'iss-3', title: 'SSO', description: 'SAML' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      );

    const { db, query } = makeDb();
    const sync = createLinearSync({
      baseUrl: BASE,
      getApiToken: async () => 'lin_key',
      teamId: TEAM,
      fetchImpl,
    });

    const result = await sync.mirror({ db });
    expect(result.upserted).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(3);

    const firstUpsert = query.mock.calls[0];
    expect(firstUpsert?.[0]).toContain('INSERT INTO backlog_entries');
    expect(firstUpsert?.[0]).toContain('ON CONFLICT (linear_id)');
    expect(firstUpsert?.[1]).toEqual(['iss-1', 'CSV exports', 'Allow CSV']);

    const secondCall = fetchImpl.mock.calls[1]!;
    const body = JSON.parse(String((secondCall[1] as RequestInit).body)) as {
      variables: { after: string };
    };
    expect(body.variables.after).toBe('cursor_page2');
  });

  it('returns { upserted: 0 } when LINEAR_TEAM_ID is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { db } = makeDb();
    const sync = createLinearSync({
      baseUrl: BASE,
      getApiToken: async () => 'lin_key',
      teamId: undefined,
      fetchImpl,
    });
    const result = await sync.mirror({ db });
    expect(result.upserted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('LinearSync.addComment', () => {
  it('sends commentCreate mutation with markdown body and correlation footer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      gql({ data: { commentCreate: { success: true } } }),
    );
    const sync = createLinearSync({
      baseUrl: BASE,
      getApiToken: async () => 'lin_key',
      teamId: TEAM,
      fetchImpl,
    });

    await sync.addComment({
      correlationId: 'corr-1',
      linearIssueId: 'iss-1',
      redactedText: '[EMAIL] wants CSV exports' as unknown as RedactedText,
      sourceUrl: 'https://example.com/ticket/42',
    });

    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as {
      variables: { input: { issueId: string; body: string } };
    };
    expect(body.variables.input.issueId).toBe('iss-1');
    expect(body.variables.input.body).toContain('[EMAIL] wants CSV exports');
    expect(body.variables.input.body).toContain('corr-1');
    expect(body.variables.input.body).toContain('https://example.com/ticket/42');
  });
});

describe('LinearSync.createIssue', () => {
  it('sends issueCreate mutation with teamId and returns the new issue id', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      gql({
        data: {
          issueCreate: { success: true, issue: { id: 'iss-new', identifier: 'ENG-99' } },
        },
      }),
    );
    const { audit, calls } = recordingAudit();
    const sync = createLinearSync({
      baseUrl: BASE,
      getApiToken: async () => 'lin_key',
      teamId: TEAM,
      fetchImpl,
      audit,
    });

    const result = await sync.createIssue({
      correlationId: 'corr-2',
      title: 'Adding CSV exports',
      descriptionRedacted: 'redacted description' as unknown as RedactedText,
    });

    expect(result.linearId).toBe('iss-new');
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as {
      variables: { input: { teamId: string; title: string } };
    };
    expect(body.variables.input.teamId).toBe(TEAM);
    expect(body.variables.input.title).toBe('Adding CSV exports');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.stage).toBe('LINEAR_CREATE');
  });

  it('throws when teamId is not set', async () => {
    const sync = createLinearSync({
      baseUrl: BASE,
      getApiToken: async () => 'lin_key',
      teamId: undefined,
      fetchImpl: vi.fn(),
    });
    await expect(
      sync.createIssue({
        correlationId: 'corr-3',
        title: 'test',
        descriptionRedacted: 'x' as unknown as RedactedText,
      }),
    ).rejects.toThrow(/LINEAR_TEAM_ID/);
  });

  it('throws when Linear returns GraphQL errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      gql({ errors: [{ message: 'Team not found' }] }),
    );
    const sync = createLinearSync({
      baseUrl: BASE,
      getApiToken: async () => 'lin_key',
      teamId: TEAM,
      fetchImpl,
    });
    await expect(
      sync.createIssue({
        correlationId: 'corr-4',
        title: 'test',
        descriptionRedacted: 'x' as unknown as RedactedText,
      }),
    ).rejects.toThrow(/Team not found/);
  });
});
