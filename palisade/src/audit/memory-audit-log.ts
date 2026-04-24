import type { AuditLogPort } from "../ports/index.js";
import type { AuditDetailsByType, AuditEvent, AuditEventType } from "../types/audit.js";
import { CorpusWriteNotPermittedError } from "../types/errors.js";

/**
 * In-process audit log — test double + local dev. Mirrors DDB semantics:
 * idempotent writes keyed on (attempt_id, action_type, timestamp), and
 * `verifyApproval` throws unless a `LABEL_APPROVED` event exists.
 */
export function createMemoryAuditLog(): AuditLogPort & { all(): AuditEvent[]; reset(): void } {
  const events: AuditEvent[] = [];

  return {
    async write<K extends AuditEventType>(
      attempt_id: string,
      actor_user_id: string,
      action_type: K,
      details: AuditDetailsByType[K],
    ): Promise<void> {
      const timestamp = new Date().toISOString();
      const sk = `AUDIT#${Date.now()}#${action_type}`;
      if (events.some((e) => e.PK === `ATTEMPT#${attempt_id}` && e.SK === sk)) return;
      events.push({
        PK: `ATTEMPT#${attempt_id}`,
        SK: sk,
        action_type,
        attempt_id,
        actor_user_id,
        timestamp,
        details,
        TTL: Math.floor(Date.now() / 1000) + 366 * 86400,
      });
    },
    async verifyApproval(attempt_id: string): Promise<void> {
      const found = events.find((e) => e.attempt_id === attempt_id && e.action_type === "LABEL_APPROVED");
      if (!found) throw new CorpusWriteNotPermittedError(attempt_id);
    },
    async query(attempt_id: string): Promise<AuditEvent[]> {
      return events.filter((e) => e.attempt_id === attempt_id);
    },
    all: () => [...events],
    reset: () => {
      events.length = 0;
    },
  };
}
