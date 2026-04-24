/**
 * Audit log writer — the source of truth for every detection, honeypot hit,
 * rate-limit escalation, label proposal, approval, and corpus write.
 *
 * CRITICAL INVARIANT: every write is AWAITED. `CORPUS_WRITE_COMPLETED` MUST
 * always be preceded by a `LABEL_APPROVED` event for the same attempt_id,
 * and the gate's `verifyApproval()` is the sole thing separating them.
 *
 * Defensive `scrubDetails` mirrors marshal — credentials never touch the
 * audit log even if a careless caller spreads an object into `details`.
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { AuditLogPort } from "../ports/index.js";
import type { AuditDetailsByType, AuditEvent, AuditEventType } from "../types/audit.js";
import { CorpusWriteNotPermittedError } from "../types/errors.js";
import type { Logger } from "../logger.js";

const AUDIT_TTL_DAYS = 366;

function computeTTL(): number {
  return Math.floor(Date.now() / 1000) + AUDIT_TTL_DAYS * 24 * 60 * 60;
}

export function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Marshal-derived scrub. Two-tier regex is defense-in-depth against careless
// callers; the typed `details` shape is the primary guard.
const SECRET_KEY_PATTERN_SUBSTRING =
  /token|secret|password|passphrase|api[_-]?key|bearer|authorization|credential|private[_-]?key|access[_-]?key|session[_-]?id|signature|hmac/i;
const SECRET_KEY_PATTERN_EXACT = /^(?:key|auth|cookie)$/i;

function isSecretKey(name: string): boolean {
  return SECRET_KEY_PATTERN_SUBSTRING.test(name) || SECRET_KEY_PATTERN_EXACT.test(name);
}

const REDACTED = "[REDACTED]";

export function scrubDetails<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => scrubDetails(v)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : scrubDetails(v);
    }
    return out as unknown as T;
  }
  return value;
}

export interface DdbAuditLogDeps {
  readonly docClient: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly logger: Logger;
}

/**
 * DDB-backed audit log. Single-table design mirrors marshal:
 *   PK = ATTEMPT#{attempt_id}
 *   SK = AUDIT#{timestamp_ms}#{action_type}
 * Idempotent via `attribute_not_exists(SK)`; strongly-consistent reads for
 * approval verification.
 */
export function createDdbAuditLog(deps: DdbAuditLogDeps): AuditLogPort {
  return {
    async write<K extends AuditEventType>(
      attempt_id: string,
      actor_user_id: string,
      action_type: K,
      details: AuditDetailsByType[K],
    ): Promise<void> {
      const timestamp = new Date().toISOString();
      const timestamp_ms = Date.now();
      const safeDetails = scrubDetails(details);
      const event: AuditEvent<K> = {
        PK: `ATTEMPT#${attempt_id}`,
        SK: `AUDIT#${timestamp_ms}#${action_type}`,
        action_type,
        attempt_id,
        actor_user_id,
        timestamp,
        details: safeDetails,
        TTL: computeTTL(),
      };
      try {
        await deps.docClient.send(
          new PutCommand({
            TableName: deps.tableName,
            Item: event,
            ConditionExpression: "attribute_not_exists(SK)",
          }),
        );
        deps.logger.info({ attempt_id, action_type, actor_user_id }, "Audit event written");
      } catch (err) {
        if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
          deps.logger.debug({ attempt_id, action_type }, "Audit event already exists (idempotent write)");
          return;
        }
        deps.logger.error({ attempt_id, action_type, error: stringifyError(err) }, "CRITICAL: Audit write failed");
        throw err;
      }
    },

    async verifyApproval(attempt_id: string): Promise<void> {
      // NO Limit — DDB applies Limit before FilterExpression. A Limit=1 would
      // return the earliest AUDIT# entry (likely DETECTION_BLOCKED) and then
      // filter it out, reporting a missing approval even when one exists.
      const result = await deps.docClient.send(
        new QueryCommand({
          TableName: deps.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          FilterExpression: "action_type = :action_type",
          ExpressionAttributeValues: {
            ":pk": `ATTEMPT#${attempt_id}`,
            ":sk": "AUDIT#",
            ":action_type": "LABEL_APPROVED",
          },
          ConsistentRead: true,
        }),
      );
      if (!result.Items || result.Items.length === 0) {
        deps.logger.error({ attempt_id }, "CRITICAL SECURITY VIOLATION: Corpus write without LABEL_APPROVED audit event");
        throw new CorpusWriteNotPermittedError(attempt_id);
      }
      deps.logger.info({ attempt_id }, "Approval verified — corpus write permitted");
    },

    async query(attempt_id: string): Promise<AuditEvent[]> {
      const result = await deps.docClient.send(
        new QueryCommand({
          TableName: deps.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: {
            ":pk": `ATTEMPT#${attempt_id}`,
            ":sk": "AUDIT#",
          },
        }),
      );
      return (result.Items ?? []) as AuditEvent[];
    },
  };
}
