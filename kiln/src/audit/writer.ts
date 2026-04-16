import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

/**
 * Audit event types — every significant Kiln action must be audited.
 */
export type AuditEventType =
  | "PR_OPENED"
  | "PR_MERGED"
  | "CONFIG_READ"
  | "CONFIG_WRITE"
  | "CHANGELOG_FETCHED"
  | "BREAKING_CHANGE_DETECTED"
  | "PATCH_APPLIED"
  | "PATCH_FLAGGED"
  | "RATE_LIMIT_CONSUMED"
  | "RATE_LIMIT_EXHAUSTED";

export interface AuditEvent {
  eventType: AuditEventType;
  teamId: string;
  orgId: string;
  /** Correlation ID from the originating request */
  correlationId: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Structured payload — event-specific */
  payload: Record<string, unknown>;
}

export interface AuditWriterOptions {
  tableName: string;
  client: DynamoDBDocumentClient;
  /** DLQ handler — called synchronously on DynamoDB throttle (not fire-and-forget) */
  onDlq?: (event: AuditEvent, error: Error) => Promise<void>;
}

/**
 * Blocking audit writer.
 *
 * Security invariant: audit writes are ALWAYS awaited — never fire-and-forget.
 * If DynamoDB throttles, the onDlq handler is called synchronously and the
 * error is rethrown so the caller can surface it.
 */
export class AuditWriter {
  private readonly table: string;
  private readonly ddb: DynamoDBDocumentClient;
  private readonly onDlq?: (event: AuditEvent, error: Error) => Promise<void>;

  constructor(opts: AuditWriterOptions) {
    this.table = opts.tableName;
    this.ddb = opts.client;
    this.onDlq = opts.onDlq;
  }

  /**
   * Write an audit event. Always awaited — never returns until the write succeeds
   * or the DLQ handler has been called.
   *
   * Retention: 1 year (enforced by DynamoDB TTL on `expiresAt` attribute).
   */
  async write(event: Omit<AuditEvent, "timestamp">): Promise<void> {
    const timestamp = new Date().toISOString();
    const eventId = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

    const fullEvent: AuditEvent = { ...event, timestamp };

    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: `AUDIT#${event.teamId}`,
            sk: `${timestamp}#${eventId}`,
            eventId,
            expiresAt,
            ...fullEvent,
          },
        })
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.onDlq) {
        await this.onDlq(fullEvent, error);
      }
      throw error;
    }
  }

  /**
   * Build an AuditEvent for a PR opening.
   */
  static prOpenedEvent(opts: {
    teamId: string;
    orgId: string;
    correlationId: string;
    prNumber: number;
    prUrl: string;
    packageName: string;
    fromVersion: string;
    toVersion: string;
    patchCount: number;
    flaggedCount: number;
  }): Omit<AuditEvent, "timestamp"> {
    return {
      eventType: "PR_OPENED",
      teamId: opts.teamId,
      orgId: opts.orgId,
      correlationId: opts.correlationId,
      payload: {
        prNumber: opts.prNumber,
        prUrl: opts.prUrl,
        packageName: opts.packageName,
        fromVersion: opts.fromVersion,
        toVersion: opts.toVersion,
        patchCount: opts.patchCount,
        flaggedCount: opts.flaggedCount,
      },
    };
  }

  /**
   * Build an AuditEvent for a config read.
   */
  static configReadEvent(opts: {
    teamId: string;
    orgId: string;
    correlationId: string;
    readByTeamId: string;
    isPlatformTeam: boolean;
  }): Omit<AuditEvent, "timestamp"> {
    return {
      eventType: "CONFIG_READ",
      teamId: opts.teamId,
      orgId: opts.orgId,
      correlationId: opts.correlationId,
      payload: {
        readByTeamId: opts.readByTeamId,
        isPlatformTeam: opts.isPlatformTeam,
      },
    };
  }
}
