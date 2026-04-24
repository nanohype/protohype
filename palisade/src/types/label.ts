import type { AttackTaxonomy } from "./corpus.js";

export type LabelDraftStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED";

export interface LabelDraft {
  readonly draftId: string;
  readonly attemptId: string;
  readonly promptText: string;
  readonly bodySha256: string;
  readonly taxonomy: AttackTaxonomy;
  readonly label: string;
  readonly status: LabelDraftStatus;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}
