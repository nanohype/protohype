import { describe, it, expect, vi } from 'vitest';
import { createProposalsRepository } from './proposals-repository.js';
import type { AuthClaims } from '../lib/auth.js';
import type { AuditPort, AuditLogEntry } from '../lib/audit.js';
import type { Pool } from 'pg';

const squadClaims: AuthClaims = {
  sub: 'user-alice',
  email: 'alice@example.com',
  squadIds: ['growth'],
  isCsm: false,
};

const csmClaims: AuthClaims = {
  sub: 'user-csm-1',
  email: 'csm@example.com',
  squadIds: [],
  isCsm: true,
};

function recordingAudit(): { audit: AuditPort; calls: AuditLogEntry[] } {
  const calls: AuditLogEntry[] = [];
  return { audit: async (entry) => void calls.push(entry), calls };
}

function makeDb(...responses: Array<{ rows: unknown[] }>): {
  db: Pool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  return { db: { query } as unknown as Pool, query };
}

describe('proposalsRepository.list', () => {
  it('passes squadIds, isCsm, csmIds, status, limit as $1..$5 in order', async () => {
    const { db, query } = makeDb({ rows: [] });
    const { audit } = recordingAudit();
    await createProposalsRepository(db, { audit }).list(squadClaims, {
      status: 'pending',
      limit: 25,
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('raw_evidence.acl_squad_ids && $1::text[]');
    expect(sql).toContain('raw_evidence.acl_csm_ids && $3::text[]');
    expect(sql).toContain('JOIN raw_evidence');
    expect(params[0]).toEqual(['growth']);
    expect(params[1]).toBe(false);
    expect(params[2]).toEqual([]);
    expect(params[3]).toBe('pending');
    expect(params[4]).toBe(25);
  });

  it('passes the CSM list as a single-element array of the user sub when caller is a CSM', async () => {
    const { db, query } = makeDb({ rows: [] });
    const { audit } = recordingAudit();
    await createProposalsRepository(db, { audit }).list(csmClaims);
    const params = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(params[1]).toBe(true);
    expect(params[2]).toEqual(['user-csm-1']);
  });

  it('caps limit at 200 even if a larger value is requested', async () => {
    const { db, query } = makeDb({ rows: [] });
    const { audit } = recordingAudit();
    await createProposalsRepository(db, { audit }).list(squadClaims, { limit: 9999 });
    const params = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(params[4]).toBe(200);
  });

  it('appends a `proposed_at < $N` cursor when `before` is provided', async () => {
    const { db, query } = makeDb({ rows: [] });
    const { audit } = recordingAudit();
    const before = new Date('2026-01-01T00:00:00Z');
    await createProposalsRepository(db, { audit }).list(squadClaims, { before });
    const sql = (query.mock.calls[0] as [string, unknown[]])[0];
    const params = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(sql).toContain('proposed_at < $6');
    expect(params).toContain(before);
  });

  it('maps SQL rows to ProposalSummary, parsing proposal_score as float', async () => {
    const { db } = makeDb({
      rows: [
        {
          id: 'fi-1',
          correlation_id: 'corr-1',
          source: 'slack',
          source_url: 'https://acme.slack.com/archives/C-feedback/p42',
          redacted_text: '[EMAIL] wants CSV exports',
          proposed_at: new Date('2026-04-01T12:00:00Z'),
          proposal_score: '0.91',
          status: 'pending',
          proposed_entry_id: 'be-1',
          linear_id: 'lin-csv',
          backlog_title: 'CSV exports',
        },
      ],
    });
    const { audit } = recordingAudit();
    const r = await createProposalsRepository(db, { audit }).list(squadClaims);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      id: 'fi-1',
      source: 'slack',
      proposalScore: 0.91,
      backlogEntryId: 'be-1',
      linearId: 'lin-csv',
      backlogTitle: 'CSV exports',
    });
  });
});

describe('proposalsRepository.get', () => {
  it('returns null when the row exists but the caller has no overlap with the ACL', async () => {
    const { db } = makeDb({ rows: [] });
    const { audit } = recordingAudit();
    expect(await createProposalsRepository(db, { audit }).get(squadClaims, 'fi-x')).toBeNull();
  });

  it('returns the ProposalSummary when the ACL matches', async () => {
    const { db } = makeDb({
      rows: [
        {
          id: 'fi-1',
          correlation_id: 'corr-1',
          source: 'slack',
          source_url: null,
          redacted_text: 'redacted',
          proposed_at: new Date(),
          proposal_score: '0.83',
          status: 'pending',
          proposed_entry_id: 'be-1',
          linear_id: 'lin-csv',
          backlog_title: 'CSV exports',
        },
      ],
    });
    const { audit } = recordingAudit();
    const r = await createProposalsRepository(db, { audit }).get(squadClaims, 'fi-1');
    expect(r?.id).toBe('fi-1');
    expect(r?.proposalScore).toBeCloseTo(0.83);
  });
});

describe('proposalsRepository.setStatus', () => {
  it('returns null when the proposal is not visible to the caller (ACL miss); only the get probe runs', async () => {
    const { db, query } = makeDb({ rows: [] });
    const { audit } = recordingAudit();
    const r = await createProposalsRepository(db, { audit }).setStatus(
      squadClaims,
      'fi-x',
      'approved',
    );
    expect(r).toBeNull();
    expect(query.mock.calls).toHaveLength(1);
  });

  it('updates status, audits APPROVE with actor=claims.sub and previous/new statuses, returns the row', async () => {
    const existing = {
      id: 'fi-1',
      correlation_id: 'corr-1',
      source: 'slack',
      source_url: null,
      redacted_text: 'redacted',
      proposed_at: new Date('2026-04-01T12:00:00Z'),
      proposal_score: '0.9',
      status: 'pending',
      proposed_entry_id: 'be-1',
      linear_id: 'lin-csv',
      backlog_title: 'CSV exports',
    };
    const updated = { ...existing, status: 'approved' };
    const { db } = makeDb({ rows: [existing] }, { rows: [updated] });
    const { audit, calls } = recordingAudit();
    const r = await createProposalsRepository(db, { audit }).setStatus(
      squadClaims,
      'fi-1',
      'approved',
      'looks right',
    );
    expect(r?.status).toBe('approved');
    expect(calls).toHaveLength(1);
    const a = calls[0]!;
    expect(a.stage).toBe('APPROVE');
    expect(a.actor).toBe('user-alice');
    expect(a.feedbackItemId).toBe('fi-1');
    expect(a.backlogEntryId).toBe('be-1');
    const detail = a.detail as Record<string, unknown>;
    expect(detail['previousStatus']).toBe('pending');
    expect(detail['newStatus']).toBe('approved');
    expect(detail['reason']).toBe('looks right');
  });

  it('emits stage REJECT for status="rejected" and DEFER for status="deferred"', async () => {
    const existing = {
      id: 'fi-1',
      correlation_id: 'corr-1',
      source: 'slack',
      source_url: null,
      redacted_text: 'r',
      proposed_at: new Date(),
      proposal_score: null,
      status: 'pending',
      proposed_entry_id: null,
      linear_id: null,
      backlog_title: null,
    };

    const r1 = makeDb({ rows: [existing] }, { rows: [{ ...existing, status: 'rejected' }] });
    const a1 = recordingAudit();
    await createProposalsRepository(r1.db, { audit: a1.audit }).setStatus(
      squadClaims,
      'fi-1',
      'rejected',
    );
    expect(a1.calls.at(-1)?.stage).toBe('REJECT');

    const r2 = makeDb({ rows: [existing] }, { rows: [{ ...existing, status: 'deferred' }] });
    const a2 = recordingAudit();
    await createProposalsRepository(r2.db, { audit: a2.audit }).setStatus(
      squadClaims,
      'fi-1',
      'deferred',
    );
    expect(a2.calls.at(-1)?.stage).toBe('DEFER');
  });
});
