import type { Logger } from "../logger.js";
import type { ApprovalGatePort } from "../publish/approval-gate.js";
import { ApprovalRequiredError } from "../publish/types.js";
import type { JobHandler } from "../consumer/types.js";
import { PublishJob } from "./types.js";

// ── Publish handler ───────────────────────────────────────────────
//
// Receives a (memoId, clientId) pair and hands it to the approval
// gate. ApprovalRequiredError short-circuits to a soft-success
// acknowledge — the memo is still pending_review, and when a human
// flips it to `approved`, an operator runbook enqueues another
// publish attempt. Any OTHER error propagates so SQS + DLQ catches
// it.
//

export interface PublishHandlerDeps {
  readonly gate: ApprovalGatePort;
  readonly logger: Logger;
}

export function createPublishHandler(deps: PublishHandlerDeps): JobHandler {
  const { gate, logger } = deps;

  return async (job) => {
    const parsed = PublishJob.safeParse(job.data);
    if (!parsed.success) {
      logger.error("publish job payload failed schema", { jobId: job.id });
      throw new Error("publish job payload failed schema");
    }
    const { memoId, clientId } = parsed.data;
    try {
      const result = await gate.publish(memoId, clientId);
      logger.info("memo published", {
        memoId,
        clientId,
        pageId: result.page.pageId,
        pageUrl: result.page.pageUrl,
      });
    } catch (err) {
      if (err instanceof ApprovalRequiredError) {
        // Not approved yet — acknowledge quietly. The operator
        // workflow re-enqueues once the memo flips to approved.
        logger.info("publish deferred: memo not approved", {
          memoId,
          clientId,
          actualStatus: err.actualStatus,
        });
        return;
      }
      throw err;
    }
  };
}
