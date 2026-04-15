import type { Pool } from 'pg';
import { auditLog, type AuditPort } from '../lib/audit.js';
import { logger, withCorrelation } from '../lib/observability.js';
import type { DlqMessage } from '../lib/queue.js';
import { findMatch, type MatchProposal, type MatcherDeps } from '../matching/matcher.js';
import { redactPii, type RedactionResult } from '../matching/pii-redactor.js';
import { embedSingle } from '../matching/embedder.js';
import type { RedactedText } from '../matching/redacted-text.js';
import type { RawFeedbackItem } from './types.js';

/**
 * Result of running a single RawFeedbackItem through the full pipeline.
 * `feedbackItemId` is the UUID of the persisted feedback_items row.
 */
export interface PipelineResult {
  correlationId: string;
  feedbackItemId: string;
  proposal: MatchProposal;
}

/**
 * Dependencies the pipeline composes. Held as an interface so tests can
 * stub them without touching the network or AWS SDKs.
 */
export interface PipelineDeps {
  db: Pool;
  matcherDeps: MatcherDeps;
  dlq: { sendMessage: (m: DlqMessage) => Promise<void> };
  /** Audit writer; defaults to the singleton `auditLog`. Tests pass
   *  a `vi.fn<AuditPort>()` and assert on the AuditLogEntry shape. */
  audit?: AuditPort;
  /** Overrides for the side-effecting helpers; defaults wire up the real
   *  redactPii / embedSingle / findMatch implementations. */
  redact?: (correlationId: string, text: string) => Promise<RedactionResult>;
  embed?: (correlationId: string, text: RedactedText) => Promise<number[]>;
  match?: typeof findMatch;
}

export async function processFeedbackItem(
  item: RawFeedbackItem,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const correlationId = crypto.randomUUID();
  const redact = deps.redact ?? redactPii;
  const embed = deps.embed ?? embedSingle;
  const match = deps.match ?? findMatch;
  const audit = deps.audit ?? auditLog;

  return withCorrelation(correlationId, 'PIPELINE', async () => {
    try {
      await audit({
        correlationId,
        stage: 'INGEST',
        detail: { source: item.source, sourceItemId: item.sourceItemId },
      });

      const redaction = await redact(correlationId, item.verbatimText);
      const embedding = await embed(correlationId, redaction.redactedText);

      const feedbackItemId = await persistFeedbackItem(
        deps.db,
        correlationId,
        item,
        redaction.redactedText,
        embedding,
      );

      const proposal = await match(
        correlationId,
        feedbackItemId,
        embedding,
        redaction.redactedText,
        deps.matcherDeps,
      );

      await persistProposal(deps.db, feedbackItemId, proposal);

      await audit({
        correlationId,
        stage: 'PROPOSE',
        feedbackItemId,
        backlogEntryId: proposal.backlogEntryId,
        detail: { type: proposal.type, similarityScore: proposal.similarityScore },
      });

      return { correlationId, feedbackItemId, proposal };
    } catch (err) {
      logger.error('pipeline failed', {
        correlationId,
        source: item.source,
        sourceItemId: item.sourceItemId,
        error: String(err),
      });
      await deps.dlq.sendMessage({
        correlationId,
        stage: 'PIPELINE',
        source: item.source,
        sourceItemId: item.sourceItemId,
        error: String(err),
        timestamp: new Date().toISOString(),
      });
      throw err;
    }
  });
}

async function persistFeedbackItem(
  db: Pool,
  correlationId: string,
  item: RawFeedbackItem,
  redactedText: RedactedText,
  embedding: number[],
): Promise<string> {
  const embeddingLiteral = `[${embedding.join(',')}]`;
  // Idempotent insert: if (source, source_item_id) already exists we
  // re-use the existing row. RETURNING wraps both branches.
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO feedback_items
       (correlation_id, source, source_item_id, source_url, redacted_text, embedding, status)
     VALUES ($1, $2, $3, $4, $5, $6::vector, 'pending')
     ON CONFLICT (source, source_item_id) DO UPDATE SET source_url = EXCLUDED.source_url
     RETURNING id`,
    [
      correlationId,
      item.source,
      item.sourceItemId,
      item.sourceUrl ?? null,
      redactedText,
      embeddingLiteral,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('persistFeedbackItem: no id returned');

  // Persist evidence row (verbatim + ACL). One per ingest; a re-poll of
  // the same item produces another evidence row, which is fine —
  // raw_evidence has no uniqueness constraint and the API always picks
  // the latest by created_at when displaying.
  await db.query(
    `INSERT INTO raw_evidence
       (feedback_item_id, verbatim_text, customer_ref, acl_squad_ids, acl_csm_ids)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, item.verbatimText, item.customerRef ?? null, item.aclSquadIds ?? [], item.aclCsmIds ?? []],
  );

  return id;
}

async function persistProposal(
  db: Pool,
  feedbackItemId: string,
  proposal: MatchProposal,
): Promise<void> {
  await db.query(
    `UPDATE feedback_items
        SET proposed_entry_id = $2,
            proposed_at       = NOW(),
            proposal_score    = $3
      WHERE id = $1`,
    [feedbackItemId, proposal.backlogEntryId ?? null, proposal.similarityScore ?? null],
  );
}
