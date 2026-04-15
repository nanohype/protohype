/**
 * The shape every connector emits. The pipeline takes one of these and
 * produces a MatchProposal (LINK or NEW) plus the persisted feedback_items
 * row keyed by the (source, sourceItemId) idempotency unique constraint.
 */
export type SourceType = 'slack' | 'webhook';

export interface RawFeedbackItem {
  source: SourceType;
  /** Stable identifier from the source system. Combined with `source` to
   *  enforce one-row-per-feedback at the DB level (UNIQUE constraint on
   *  feedback_items(source, source_item_id)). */
  sourceItemId: string;
  /** Optional canonical URL to the feedback in the source system, for
   *  PM provenance and audit trails. */
  sourceUrl?: string | undefined;
  /** Raw, un-redacted feedback text. The pipeline runs this through
   *  redactPii before any embedding or persistence. */
  verbatimText: string;
  /** Customer reference (Slack user ID, webhook-provided ID, etc.) —
   *  used to derive raw_evidence.customer_ref for the PM evidence
   *  drawer. */
  customerRef?: string | undefined;
  /** Squad and CSM ACLs from the source system (Slack channel →
   *  squad mapping, webhook-provided ACL hints). Stored on
   *  raw_evidence.acl_* and used by the API's server-side ACL filter. */
  aclSquadIds?: string[] | undefined;
  aclCsmIds?: string[] | undefined;
  /** Free-form per-source metadata, persisted as JSONB on raw_evidence
   *  for debugging. Never used in business logic. */
  metadata?: Record<string, unknown> | undefined;
}
