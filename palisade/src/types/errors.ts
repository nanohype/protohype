export class CorpusWriteNotPermittedError extends Error {
  override readonly name = "CorpusWriteNotPermittedError";
  constructor(attemptId: string) {
    super(`Corpus write blocked — LABEL_APPROVED audit event missing for attempt ${attemptId}`);
  }
}

export class DetectionTimeoutError extends Error {
  override readonly name = "DetectionTimeoutError";
  constructor(layer: string, timeoutMs: number) {
    super(`Detection layer ${layer} exceeded ${timeoutMs}ms`);
  }
}

export class UpstreamForbiddenError extends Error {
  override readonly name = "UpstreamForbiddenError";
  constructor(upstream: string) {
    super(`Upstream ${upstream} not allowed by configuration`);
  }
}

export class LabelDraftStateError extends Error {
  override readonly name = "LabelDraftStateError";
  constructor(draftId: string, state: string) {
    super(`Label draft ${draftId} is not in PENDING_APPROVAL state (current: ${state})`);
  }
}
