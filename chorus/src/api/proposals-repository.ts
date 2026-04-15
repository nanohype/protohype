import type { Pool } from 'pg';
import type { AuthClaims } from '../lib/auth.js';
import { auditLog, type AuditPort, type AuditStage } from '../lib/audit.js';

/**
 * Server-side ACL filter: a row is visible to the caller iff
 *   raw_evidence.acl_squad_ids && $squadIds::text[]
 *   OR (caller is CSM AND raw_evidence.acl_csm_ids && $csmIds::text[])
 *
 * The filter is applied in SQL — never post-fetch — so a user cannot
 * even see the existence of evidence they are not entitled to read.
 * Callers pass the user's squadIds and (when applicable) their own
 * `sub` as a single-element csmIds list.
 */
const ACL_PREDICATE = `(
  raw_evidence.acl_squad_ids && $1::text[]
  OR ($2::boolean AND raw_evidence.acl_csm_ids && $3::text[])
)`;

export interface ProposalSummary {
  id: string;
  correlationId: string;
  source: string;
  sourceUrl: string | null;
  redactedText: string;
  proposedAt: Date | null;
  proposalScore: number | null;
  status: string;
  /** When proposal type is LINK, the existing backlog entry. NULL for NEW. */
  backlogEntryId: string | null;
  linearId: string | null;
  backlogTitle: string | null;
}

export interface ListProposalsOptions {
  status?: 'pending' | 'approved' | 'rejected' | 'deferred' | undefined;
  limit?: number | undefined;
  /** Cursor: only return rows with proposed_at < this. */
  before?: Date | undefined;
}

export interface ProposalsRepository {
  list(claims: AuthClaims, opts?: ListProposalsOptions): Promise<ProposalSummary[]>;
  get(claims: AuthClaims, id: string): Promise<ProposalSummary | null>;
  setStatus(
    claims: AuthClaims,
    id: string,
    status: 'approved' | 'rejected' | 'deferred',
    reason?: string,
  ): Promise<ProposalSummary | null>;
}

export interface ProposalsRepositoryDeps {
  audit?: AuditPort;
}

export function createProposalsRepository(
  db: Pool,
  deps: ProposalsRepositoryDeps = {},
): ProposalsRepository {
  const audit = deps.audit ?? auditLog;
  return {
    async list(claims, opts = {}) {
      const status = opts.status ?? 'pending';
      const limit = Math.min(opts.limit ?? 50, 200);

      const params: unknown[] = [
        claims.squadIds,
        claims.isCsm,
        claims.isCsm ? [claims.sub] : [],
        status,
        limit,
      ];
      let sql = `
        SELECT DISTINCT
          fi.id, fi.correlation_id, fi.source, fi.source_url,
          fi.redacted_text, fi.proposed_at, fi.proposal_score, fi.status,
          fi.proposed_entry_id, be.linear_id, be.title AS backlog_title
        FROM feedback_items fi
        JOIN raw_evidence ON raw_evidence.feedback_item_id = fi.id
        LEFT JOIN backlog_entries be ON be.id = fi.proposed_entry_id
        WHERE ${ACL_PREDICATE}
          AND fi.status = $4
      `;
      if (opts.before) {
        params.push(opts.before);
        sql += `AND fi.proposed_at < $${params.length} `;
      }
      sql += `ORDER BY fi.proposed_at DESC NULLS LAST LIMIT $5`;

      const { rows } = await db.query<{
        id: string;
        correlation_id: string;
        source: string;
        source_url: string | null;
        redacted_text: string;
        proposed_at: Date | null;
        proposal_score: string | null;
        status: string;
        proposed_entry_id: string | null;
        linear_id: string | null;
        backlog_title: string | null;
      }>(sql, params);

      return rows.map(rowToSummary);
    },

    async get(claims, id) {
      const { rows } = await db.query<{
        id: string;
        correlation_id: string;
        source: string;
        source_url: string | null;
        redacted_text: string;
        proposed_at: Date | null;
        proposal_score: string | null;
        status: string;
        proposed_entry_id: string | null;
        linear_id: string | null;
        backlog_title: string | null;
      }>(
        `SELECT
           fi.id, fi.correlation_id, fi.source, fi.source_url,
           fi.redacted_text, fi.proposed_at, fi.proposal_score, fi.status,
           fi.proposed_entry_id, be.linear_id, be.title AS backlog_title
         FROM feedback_items fi
         JOIN raw_evidence ON raw_evidence.feedback_item_id = fi.id
         LEFT JOIN backlog_entries be ON be.id = fi.proposed_entry_id
         WHERE fi.id = $4 AND ${ACL_PREDICATE}
         LIMIT 1`,
        [claims.squadIds, claims.isCsm, claims.isCsm ? [claims.sub] : [], id],
      );
      const row = rows[0];
      return row ? rowToSummary(row) : null;
    },

    async setStatus(claims, id, status, reason) {
      // Two-step transaction: (1) verify ACL via SELECT with predicate,
      // (2) UPDATE only if SELECT returned a row. Doing the check
      // inside the UPDATE WHERE works too but obscures the difference
      // between "not found" and "forbidden" — both surface as null
      // here, which is the intended API contract: the route maps null
      // to 404 for both, denying existence to unauthorized callers.
      const existing = await this.get(claims, id);
      if (!existing) return null;
      const stage = STATUS_TO_AUDIT_STAGE[status];
      const { rows } = await db.query<{
        id: string;
        correlation_id: string;
        source: string;
        source_url: string | null;
        redacted_text: string;
        proposed_at: Date | null;
        proposal_score: string | null;
        status: string;
        proposed_entry_id: string | null;
      }>(
        `UPDATE feedback_items
            SET status = $2
          WHERE id = $1
          RETURNING id, correlation_id, source, source_url, redacted_text,
                    proposed_at, proposal_score, status, proposed_entry_id`,
        [id, status],
      );
      const updated = rows[0];
      if (!updated) return null;

      await audit({
        correlationId: updated.correlation_id,
        stage,
        actor: claims.sub,
        feedbackItemId: id,
        backlogEntryId: updated.proposed_entry_id ?? undefined,
        detail: { previousStatus: existing.status, newStatus: status, reason },
      });

      return {
        ...rowToSummary({
          ...updated,
          linear_id: existing.linearId,
          backlog_title: existing.backlogTitle,
        }),
      };
    },
  };
}

const STATUS_TO_AUDIT_STAGE: Record<'approved' | 'rejected' | 'deferred', AuditStage> = {
  approved: 'APPROVE',
  rejected: 'REJECT',
  deferred: 'DEFER',
};

function rowToSummary(row: {
  id: string;
  correlation_id: string;
  source: string;
  source_url: string | null;
  redacted_text: string;
  proposed_at: Date | null;
  proposal_score: string | null;
  status: string;
  proposed_entry_id: string | null;
  linear_id: string | null;
  backlog_title: string | null;
}): ProposalSummary {
  return {
    id: row.id,
    correlationId: row.correlation_id,
    source: row.source,
    sourceUrl: row.source_url,
    redactedText: row.redacted_text,
    proposedAt: row.proposed_at,
    proposalScore: row.proposal_score === null ? null : Number.parseFloat(row.proposal_score),
    status: row.status,
    backlogEntryId: row.proposed_entry_id,
    linearId: row.linear_id,
    backlogTitle: row.backlog_title,
  };
}
