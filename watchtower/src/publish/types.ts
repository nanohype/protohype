import type { MemoRecord } from "../memo/types.js";

// ── Publisher contracts ────────────────────────────────────────────
//
// A `PublisherPort` wraps a destination KB (Notion, Confluence). The
// concrete adapter handles HTTP, schema conversion, and authentication;
// the approval gate is the only code path that calls it.
//

export interface PublishedPage {
  readonly pageId: string;
  readonly pageUrl: string;
  readonly destination: "notion" | "confluence";
}

export interface PublisherPort {
  readonly destination: "notion" | "confluence";
  publish(memo: MemoRecord, destinationRef: string): Promise<PublishedPage>;
}

// ── Approval gate errors ───────────────────────────────────────────

export class ApprovalRequiredError extends Error {
  readonly memoId: string;
  readonly actualStatus: string | "missing";
  constructor(memoId: string, actualStatus: string | "missing") {
    super(`publish blocked: memo ${memoId} is in state "${actualStatus}" (expected "approved")`);
    this.name = "ApprovalRequiredError";
    this.memoId = memoId;
    this.actualStatus = actualStatus;
  }
}

export class PublishConflictError extends Error {
  readonly memoId: string;
  constructor(memoId: string, cause: string) {
    super(`publish blocked: memo ${memoId} state changed mid-publish (${cause})`);
    this.name = "PublishConflictError";
    this.memoId = memoId;
  }
}

/** Result of a successful gate.publish() — emitted for metrics. */
export interface GatePublishResult {
  readonly memoId: string;
  readonly clientId: string;
  readonly page: PublishedPage;
}
