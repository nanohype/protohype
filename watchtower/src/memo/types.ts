import { z } from "zod";

// ── Memo contracts ─────────────────────────────────────────────────
//
// A memo is a 1–2 paragraph draft produced by the memo drafter after
// a rule change scores high enough to alert. Memos live in DynamoDB
// in one of four states:
//
//   pending_review   drafted, awaiting human approval
//   approved         operator approved; queued for publish
//   published        published to Notion/Confluence
//   rejected         operator rejected; archived
//
// Transitions are monotonic (no "unpublished"). The approval gate
// reads `status === "approved"` with ConsistentRead before publishing.
//

export const MemoStatus = z.enum(["pending_review", "approved", "published", "rejected"]);
export type MemoStatus = z.infer<typeof MemoStatus>;

export const MemoRecordSchema = z.object({
  memoId: z.string().min(1),
  clientId: z.string().min(1),
  ruleChangeId: z.string().min(1),
  sourceId: z.string().min(1),
  status: MemoStatus,
  title: z.string().min(1),
  body: z.string().min(1),
  model: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().datetime().optional(),
  publishedPageId: z.string().optional(),
  publishedAt: z.string().datetime().optional(),
  rejectedReason: z.string().optional(),
});

export type MemoRecord = z.infer<typeof MemoRecordSchema>;

export interface MemoStoragePort {
  /** Insert a new memo in `pending_review` state. */
  create(memo: MemoRecord): Promise<void>;

  /** Fetch a memo with ConsistentRead semantics (strong consistency). */
  getConsistent(memoId: string, clientId: string): Promise<MemoRecord | null>;

  /** Update status with optimistic concurrency — fails if prior state mismatches. */
  transition(
    memoId: string,
    clientId: string,
    from: MemoStatus,
    update: Partial<MemoRecord> & { status: MemoStatus },
  ): Promise<void>;
}
