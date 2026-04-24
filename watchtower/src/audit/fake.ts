import type { AuditEvent, AuditPort } from "./types.js";

// ── In-memory audit fake ────────────────────────────────────────────
//
// Test double for `AuditPort`. Records every emitted event and
// optionally simulates failures (for exercising the caller's
// error-handling paths — the approval gate, for example, must
// FAIL if the audit write fails).
//

export interface FakeAudit extends AuditPort {
  readonly events: readonly AuditEvent[];
  failNext: (err?: Error) => void;
  clear: () => void;
}

export function createFakeAudit(): FakeAudit {
  const events: AuditEvent[] = [];
  let pendingFailure: Error | null = null;

  return {
    async emit(event: AuditEvent): Promise<void> {
      if (pendingFailure) {
        const err = pendingFailure;
        pendingFailure = null;
        throw err;
      }
      events.push(event);
    },
    get events() {
      return events;
    },
    failNext(err = new Error("audit write failed")) {
      pendingFailure = err;
    },
    clear() {
      events.length = 0;
      pendingFailure = null;
    },
  };
}
