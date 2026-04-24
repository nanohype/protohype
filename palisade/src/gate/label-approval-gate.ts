/**
 * LabelApprovalGate — THE critical module.
 *
 * Invariant: this file is the ONLY file in the repo that imports
 * `CorpusWritePort` or calls `corpusWriter.addAttack(...)`. The invariant
 * is grep-enforced in CI (see `scripts/ci/grep-gate.sh`).
 *
 * Two-phase commit — matches marshal's StatuspageApprovalGate:
 *   1. Write `LABEL_APPROVED` to the audit log — AWAITED.
 *   2. Verify via strongly-consistent read that the event landed.
 *   3. Only then call `corpusWriter.addAttack(...)`.
 *   4. Write `CORPUS_WRITE_COMPLETED` — AWAITED.
 *   5. Flip the draft row to APPROVED.
 *
 * If ANY of steps 1–2 fails, step 3 never runs. If step 3 fails after 1–2,
 * we still have an approval on the audit log; retries are safe because
 * `addAttack` is idempotent (ON CONFLICT DO NOTHING) and the draft row
 * stays PENDING_APPROVAL until the full flow succeeds.
 *
 * 100% branch coverage on this file is enforced by vitest thresholds.
 */

import type { AuditLogPort, CorpusWritePort, LabelQueuePort, MetricsPort, EmbeddingPort } from "../ports/index.js";
import type { LabelDraft } from "../types/label.js";
import type { ApprovedSample, AttackTaxonomy } from "../types/corpus.js";
import { LabelDraftStateError } from "../types/errors.js";
import { MetricNames } from "../metrics.js";
import { newId, sha256Hex } from "../util/hash.js";
import type { Logger } from "../logger.js";

export interface LabelApprovalGateDeps {
  readonly audit: AuditLogPort;
  readonly corpusWriter: CorpusWritePort;
  readonly labelQueue: LabelQueuePort;
  readonly embedder: EmbeddingPort;
  readonly metrics: MetricsPort;
  readonly logger: Logger;
}

export interface ProposeInput {
  readonly attemptId: string;
  readonly promptText: string;
  readonly taxonomy: AttackTaxonomy;
  readonly label: string;
  readonly proposerUserId: string;
}

export function createLabelApprovalGate(deps: LabelApprovalGateDeps) {
  async function propose(input: ProposeInput): Promise<LabelDraft> {
    const draftId = newId("draft");
    const bodySha256 = sha256Hex(input.promptText);
    const draft: LabelDraft = {
      draftId,
      attemptId: input.attemptId,
      promptText: input.promptText,
      bodySha256,
      taxonomy: input.taxonomy,
      label: input.label,
      status: "PENDING_APPROVAL",
      proposedBy: input.proposerUserId,
      proposedAt: new Date().toISOString(),
    };
    await deps.labelQueue.enqueue(draft);
    await deps.audit.write(input.attemptId, input.proposerUserId, "LABEL_PROPOSED", {
      draftId,
      attemptId: input.attemptId,
      label: input.label,
      bodySha256,
      proposerUserId: input.proposerUserId,
    });
    deps.logger.info({ draft_id: draftId, attempt_id: input.attemptId }, "Label draft proposed");
    return draft;
  }

  async function approveAndWrite(draftId: string, approverUserId: string): Promise<{ corpusId: string }> {
    const start = Date.now();

    // ── Step 1 — load + validate draft ────────────────────────────────
    const draft = await deps.labelQueue.get(draftId);
    if (!draft) throw new Error(`Draft ${draftId} not found`);
    if (draft.status !== "PENDING_APPROVAL") throw new LabelDraftStateError(draftId, draft.status);

    // ── Step 2 — write LABEL_APPROVED audit event (AWAITED) ───────────
    const approvedAt = new Date().toISOString();
    await deps.audit.write(draft.attemptId, approverUserId, "LABEL_APPROVED", {
      draftId: draft.draftId,
      attemptId: draft.attemptId,
      bodySha256: draft.bodySha256,
      approvedAt,
    });

    // ── Step 3 — VERIFY approval landed (strongly consistent read) ────
    try {
      await deps.audit.verifyApproval(draft.attemptId);
    } catch (err) {
      deps.metrics.counter(MetricNames.GateVerificationFailed, 1);
      deps.logger.error({ draft_id: draftId, attempt_id: draft.attemptId, err }, "Gate verification failed — aborting corpus write");
      throw err;
    }

    // ── Step 4 — embed + addAttack (the protected op) ─────────────────
    const embedding = await deps.embedder.embed(draft.promptText);
    const corpusId = newId("corpus");
    const sample: ApprovedSample = {
      corpusId,
      bodySha256: draft.bodySha256,
      promptText: draft.promptText,
      embedding,
      taxonomy: draft.taxonomy,
      label: draft.label,
      approvedBy: approverUserId,
      approvedAt,
      sourceAttemptId: draft.attemptId,
    };
    // NOTE: the single call site of the corpus-write operation in the repo.
    // CI grep-gate forbids this identifier outside this file.
    await deps.corpusWriter.addAttack(sample);

    // ── Step 5 — write CORPUS_WRITE_COMPLETED (AWAITED) ───────────────
    await deps.audit.write(draft.attemptId, approverUserId, "CORPUS_WRITE_COMPLETED", {
      draftId: draft.draftId,
      attemptId: draft.attemptId,
      corpusId,
      bodySha256: draft.bodySha256,
      writtenAt: new Date().toISOString(),
    });

    // ── Step 6 — flip draft status to APPROVED ────────────────────────
    await deps.labelQueue.markApproved(draft.draftId, approverUserId);

    deps.metrics.counter(MetricNames.GateApproved, 1, { taxonomy: draft.taxonomy });
    deps.metrics.counter(MetricNames.CorpusWriteCompleted, 1);
    deps.metrics.histogram("palisade.gate.approve_latency_ms", Date.now() - start);
    deps.logger.info({ draft_id: draftId, attempt_id: draft.attemptId, corpus_id: corpusId }, "Label approved and written to corpus");

    return { corpusId };
  }

  async function rejectDraft(draftId: string, rejectorUserId: string, reason?: string): Promise<void> {
    const draft = await deps.labelQueue.get(draftId);
    if (!draft) throw new Error(`Draft ${draftId} not found`);
    if (draft.status !== "PENDING_APPROVAL") throw new LabelDraftStateError(draftId, draft.status);
    await deps.labelQueue.markRejected(draftId, rejectorUserId, reason);
    await deps.audit.write(draft.attemptId, rejectorUserId, "LABEL_REJECTED", {
      draftId,
      attemptId: draft.attemptId,
      ...(reason ? { reason } : {}),
    });
    deps.metrics.counter(MetricNames.GateRejected, 1);
  }

  return { propose, approveAndWrite, rejectDraft };
}
