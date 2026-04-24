import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { Logger } from "../logger.js";
import type { AuditEvent, AuditPort } from "./types.js";
import { AuditEventSchema } from "./types.js";

// ── SQS audit adapter ──────────────────────────────────────────────
//
// Emits audit events onto a FIFO queue. MessageGroupId = clientId
// keeps per-client events ordered without serializing across clients
// (scales horizontally). MessageDeduplicationId = eventId enforces
// exactly-once per event within the 5-minute SQS dedup window.
//
// Compliance requirement: audit write failures are visible, not
// silent. If SQS throws, the caller gets the error — they decide
// whether to fail the operation or proceed. Most adopters should
// fail (audit is a compliance record, not a log).
//

export interface SqsAuditDeps {
  readonly sqs: Pick<SQSClient, "send">;
  readonly queueUrl: string;
  readonly logger: Logger;
}

export function createSqsAuditLogger(deps: SqsAuditDeps): AuditPort {
  const { sqs, queueUrl, logger } = deps;
  return {
    async emit(event: AuditEvent): Promise<void> {
      const parsed = AuditEventSchema.safeParse(event);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new Error(`audit event failed schema validation: ${issues}`);
      }
      const validated = parsed.data;
      const command = new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(validated),
        MessageGroupId: validated.clientId,
        MessageDeduplicationId: validated.eventId,
      });
      try {
        await sqs.send(command);
      } catch (err) {
        logger.error("audit emit failed", {
          eventId: validated.eventId,
          clientId: validated.clientId,
          type: validated.type,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}
