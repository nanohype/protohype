import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import type { AuditPort } from "../audit/types.js";
import type { MemoStoragePort } from "../memo/types.js";
import type { ClientsPort } from "../clients/types.js";
import {
  ApprovalRequiredError,
  PublishConflictError,
  type GatePublishResult,
  type PublishedPage,
  type PublisherPort,
} from "./types.js";

// ── Publish approval gate ──────────────────────────────────────────
//
// THE security-critical module. This is the ONLY code path in
// watchtower that is allowed to invoke `PublisherPort.publish()`. A
// CI grep gate (`.github/workflows/watchtower-ci.yml`) enforces that
// no other file in `src/` calls `.publish(` on a publisher.
//
// Two-phase commit:
//   Phase 1 — verify approval via ConsistentRead on the memos table.
//             If memo isn't `approved`, throw ApprovalRequiredError
//             without hitting the external API.
//   Phase 2 — call the publisher, then atomically transition the
//             memo from `approved` → `published` with a
//             ConditionExpression. If the transition fails (another
//             worker beat us, or the operator rolled the approval
//             back), throw PublishConflictError.
//
// Audit events are emitted for both outcomes. Failures emit
// MEMO_PUBLISH_BLOCKED so operator dashboards show the reason.
//

export interface ApprovalGateDeps {
  readonly memos: MemoStoragePort;
  readonly clients: ClientsPort;
  readonly publishers: Readonly<Record<"notion" | "confluence", PublisherPort | undefined>>;
  readonly audit: AuditPort;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export interface ApprovalGatePort {
  /** Publish a memo — the only sanctioned path into a publisher. */
  publish(memoId: string, clientId: string): Promise<GatePublishResult>;
}

export function createApprovalGate(deps: ApprovalGateDeps): ApprovalGatePort {
  const { memos, clients, publishers, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async publish(memoId, clientId) {
      // ── Phase 1: verify approval with ConsistentRead ────────────
      const memo = await memos.getConsistent(memoId, clientId);
      if (!memo) {
        throw new ApprovalRequiredError(memoId, "missing");
      }
      if (memo.status !== "approved") {
        throw new ApprovalRequiredError(memoId, memo.status);
      }

      const client = await clients.get(clientId);
      if (!client) {
        throw new ApprovalRequiredError(memoId, "client-inactive");
      }

      // Choose destination based on client config — Notion wins when
      // both are configured (v0 simplification; a future version can
      // support publishing to both in parallel).
      const target = (() => {
        if (client.publish?.notionDatabaseId && publishers.notion) {
          return {
            publisher: publishers.notion,
            destinationRef: client.publish.notionDatabaseId,
          } as const;
        }
        if (client.publish?.confluenceSpaceKey && publishers.confluence) {
          return {
            publisher: publishers.confluence,
            destinationRef: client.publish.confluenceSpaceKey,
          } as const;
        }
        return null;
      })();

      if (!target) {
        await emitBlocked(memoId, clientId, "no configured publish destination");
        throw new ApprovalRequiredError(memoId, "no-destination");
      }

      // ── Phase 2: publish + atomic transition ────────────────────
      let page: PublishedPage;
      try {
        page = await target.publisher.publish(memo, target.destinationRef);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error("publisher call failed", { memoId, clientId, reason });
        await emitBlocked(memoId, clientId, `publisher error: ${reason}`);
        throw err;
      }

      const publishedAt = now().toISOString();
      try {
        await memos.transition(memoId, clientId, "approved", {
          status: "published",
          publishedPageId: page.pageId,
          publishedAt,
          updatedAt: publishedAt,
        });
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === "ConditionalCheckFailedException") {
          // Memo state changed mid-publish. The external page is
          // already created — we can't roll it back. Record the
          // conflict in audit so operators can triage.
          logger.error("publish state race detected (external page exists)", {
            memoId,
            clientId,
            pageId: page.pageId,
          });
          await emitBlocked(
            memoId,
            clientId,
            `state race: external page ${page.pageId} created but DDB transition rejected`,
          );
          throw new PublishConflictError(memoId, "state-race");
        }
        throw err;
      }

      await audit.emit({
        type: "MEMO_PUBLISHED",
        eventId: randomUUID(),
        timestamp: publishedAt,
        clientId,
        memoId,
        publishedPageId: page.pageId,
        destination: page.destination,
      });

      return { memoId, clientId, page };
    },
  };

  async function emitBlocked(memoId: string, clientId: string, reason: string): Promise<void> {
    try {
      await audit.emit({
        type: "MEMO_PUBLISH_BLOCKED",
        eventId: randomUUID(),
        timestamp: now().toISOString(),
        clientId,
        memoId,
        reason,
      });
    } catch (err) {
      // Audit emit failing on an already-failed path is alarming —
      // log loudly but don't mask the original error with this one.
      logger.fatal("audit emit failed on publish-blocked path", {
        memoId,
        clientId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
