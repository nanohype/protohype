import type { LabelQueuePort } from "../ports/index.js";
import type { LabelDraft, LabelDraftStatus } from "../types/label.js";

/**
 * In-process label queue — test double. Mirrors the state transitions of the
 * DDB adapter but without any network or idempotency guarantees beyond those
 * needed to exercise the gate's flow.
 */
export function createMemoryLabelQueue(): LabelQueuePort & { reset(): void; snapshot(): LabelDraft[] } {
  const drafts = new Map<string, LabelDraft>();

  return {
    async enqueue(draft): Promise<void> {
      if (drafts.has(draft.draftId)) throw new Error(`Duplicate draft ${draft.draftId}`);
      drafts.set(draft.draftId, { ...draft });
    },
    async get(draftId): Promise<LabelDraft | null> {
      return drafts.get(draftId) ?? null;
    },
    async markApproved(draftId, approver): Promise<void> {
      const d = drafts.get(draftId);
      if (!d) throw new Error(`Draft ${draftId} not found`);
      if (d.status !== "PENDING_APPROVAL") throw new Error(`Draft ${draftId} is not pending (${d.status})`);
      drafts.set(draftId, { ...d, status: "APPROVED", approvedBy: approver, approvedAt: new Date().toISOString() });
    },
    async markRejected(draftId, _rejector, _reason): Promise<void> {
      const d = drafts.get(draftId);
      if (!d) throw new Error(`Draft ${draftId} not found`);
      drafts.set(draftId, { ...d, status: "REJECTED" });
    },
    async list(status: LabelDraftStatus): Promise<LabelDraft[]> {
      return Array.from(drafts.values()).filter((d) => d.status === status);
    },
    reset: () => drafts.clear(),
    snapshot: () => Array.from(drafts.values()),
  };
}
