import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import type { AuditPort } from "../audit/types.js";
import type { ClientsPort } from "../clients/types.js";
import type { ClassifierPort } from "../classifier/types.js";
import type { MemoDrafterPort } from "../memo/drafter.js";
import type { MemoStoragePort } from "../memo/types.js";
import type { NotifierPort } from "../notify/types.js";
import type { JobHandler } from "../consumer/types.js";
import type { QueueProvider } from "../consumer/types.js";
import { ClassifyJob, type PublishJob } from "./types.js";

// ── Classify handler ──────────────────────────────────────────────
//
// Per (ruleChange, client) pair: score with the classifier, then
// route by disposition:
//
//   drop   → record in audit only
//   review → draft memo (status=pending_review), notify operator
//   alert  → draft memo, notify client, enqueue PublishJob (the
//            publish handler will still block at the approval gate
//            until the memo is flipped to `approved`)
//
// Drafting is independent of publish: memos are stored and waiting
// for approval. Fail-secure results from the classifier arrive here
// with disposition=review + failureMode set — same code path as a
// real review, with an extra audit marker so dashboards show it.
//

export interface ClassifyHandlerDeps {
  readonly classifier: ClassifierPort;
  readonly drafter: MemoDrafterPort;
  readonly memos: MemoStoragePort;
  readonly notifier: (clientId: string) => Promise<NotifierPort | null>;
  readonly publishQueue: QueueProvider;
  readonly clients: ClientsPort;
  readonly audit: AuditPort;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export function createClassifyHandler(deps: ClassifyHandlerDeps): JobHandler {
  const { classifier, drafter, memos, notifier, publishQueue, clients, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

  return async (job) => {
    const parsed = ClassifyJob.safeParse(job.data);
    if (!parsed.success) {
      logger.error("classify job payload failed schema", { jobId: job.id });
      throw new Error("classify job payload failed schema");
    }
    const { clientId, ruleChange } = parsed.data;
    const client = await clients.get(clientId);
    if (!client) {
      logger.info("client deactivated since enqueue — dropping classify job", { clientId });
      return;
    }

    const result = await classifier.classify({ change: ruleChange, client });

    await audit.emit({
      type: "APPLICABILITY_SCORED",
      eventId: randomUUID(),
      timestamp: now().toISOString(),
      clientId,
      ruleChangeId: ruleChange.contentHash,
      score: result.score,
      confidence: result.confidence,
      rationale: result.rationale,
      disposition: result.disposition,
    });

    if (result.disposition === "drop") {
      logger.debug("classify: dropping (below review threshold)", {
        clientId,
        ruleChangeId: ruleChange.contentHash,
        score: result.score,
      });
      return;
    }

    // Draft a memo for review + alert. Both dispositions get a draft —
    // reviewers need to see what the drafter produced, alerts go out
    // with a reference to it.
    const memo = await drafter.draft({ change: ruleChange, client, rationale: result.rationale });
    await memos.create(memo);
    await audit.emit({
      type: "MEMO_DRAFTED",
      eventId: randomUUID(),
      timestamp: now().toISOString(),
      clientId,
      memoId: memo.memoId,
      ruleChangeId: ruleChange.contentHash,
      model: memo.model,
    });

    const dispatcher = await notifier(clientId);
    if (dispatcher) {
      await dispatcher.send({
        clientId,
        clientName: client.name,
        memoId: memo.memoId,
        sourceId: ruleChange.sourceId,
        ruleChangeTitle: ruleChange.title,
        ruleChangeUrl: ruleChange.url,
        disposition: result.disposition,
        score: result.score,
        rationale: result.rationale,
      });
    }

    // For `alert`, proactively enqueue publish. The approval gate
    // will still block at ConsistentRead (memo is pending_review); a
    // human flipping `status: approved` is what unblocks publish
    // downstream. Enqueuing now means the moment an operator
    // approves, SQS already has a message waiting.
    if (result.disposition === "alert") {
      const payload: PublishJob = { memoId: memo.memoId, clientId };
      await publishQueue.enqueue("publish", payload);
    }
  };
}
