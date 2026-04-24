import { z } from "zod";

// ── Audit events ────────────────────────────────────────────────────
//
// Every stage in the pipeline emits an immutable audit event.
// Events are sent to a FIFO SQS queue keyed on (clientId, eventId)
// — the audit Lambda writes them to DynamoDB (hot, 90d TTL) and to
// S3 (long-term archive). The `AuditPort` interface abstracts the
// SQS adapter so tests can use an in-memory fake.
//

export const AuditEventBase = z.object({
  eventId: z.string().min(1),
  timestamp: z.string().datetime(),
  clientId: z.string().min(1),
  traceId: z.string().optional(),
});

export const RuleChangeDetected = AuditEventBase.extend({
  type: z.literal("RULE_CHANGE_DETECTED"),
  sourceId: z.string(),
  contentHash: z.string(),
  title: z.string(),
  url: z.string().url().optional(),
});

export const ApplicabilityScored = AuditEventBase.extend({
  type: z.literal("APPLICABILITY_SCORED"),
  ruleChangeId: z.string(),
  score: z.number().int().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  rationale: z.string(),
  disposition: z.enum(["drop", "review", "alert"]),
});

export const MemoDrafted = AuditEventBase.extend({
  type: z.literal("MEMO_DRAFTED"),
  memoId: z.string(),
  ruleChangeId: z.string(),
  model: z.string(),
});

export const MemoApproved = AuditEventBase.extend({
  type: z.literal("MEMO_APPROVED"),
  memoId: z.string(),
  approver: z.string(),
});

export const MemoPublished = AuditEventBase.extend({
  type: z.literal("MEMO_PUBLISHED"),
  memoId: z.string(),
  publishedPageId: z.string(),
  destination: z.enum(["notion", "confluence"]),
});

export const MemoPublishBlocked = AuditEventBase.extend({
  type: z.literal("MEMO_PUBLISH_BLOCKED"),
  memoId: z.string(),
  reason: z.string(),
});

export const AlertSent = AuditEventBase.extend({
  type: z.literal("ALERT_SENT"),
  memoId: z.string().optional(),
  channel: z.enum(["slack", "email"]),
  recipient: z.string(),
});

export const AuditEventSchema = z.discriminatedUnion("type", [
  RuleChangeDetected,
  ApplicabilityScored,
  MemoDrafted,
  MemoApproved,
  MemoPublished,
  MemoPublishBlocked,
  AlertSent,
]);

export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Port for emitting audit events. The SQS adapter is in `./sqs.ts`. */
export interface AuditPort {
  emit(event: AuditEvent): Promise<void>;
}
