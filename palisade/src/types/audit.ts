export type AuditEventType =
  | "DETECTION_BLOCKED"
  | "DETECTION_ALLOWED"
  | "HONEYPOT_HIT"
  | "RATE_LIMIT_ESCALATED"
  | "LABEL_PROPOSED"
  | "LABEL_APPROVED"
  | "LABEL_REJECTED"
  | "CORPUS_WRITE_COMPLETED"
  | "UPSTREAM_FORWARD_FAILED";

export interface AuditDetailsByType {
  DETECTION_BLOCKED: {
    promptHash: string;
    promptSha256: string;
    blockingLayer: "heuristics" | "classifier" | "corpus-match";
    layerScores: Record<string, number>;
    upstream: string;
  };
  DETECTION_ALLOWED: {
    promptHash: string;
    layerScores: Record<string, number>;
    upstream: string;
  };
  HONEYPOT_HIT: {
    promptHash: string;
    endpoint: string;
    fingerprint: string;
    bodyLength: number;
  };
  RATE_LIMIT_ESCALATED: {
    reason: string;
    severity: "soft" | "hard";
    ttlSeconds: number;
  };
  LABEL_PROPOSED: {
    draftId: string;
    attemptId: string;
    label: string;
    bodySha256: string;
    proposerUserId: string;
  };
  LABEL_APPROVED: {
    draftId: string;
    attemptId: string;
    bodySha256: string;
    approvedAt: string;
  };
  LABEL_REJECTED: {
    draftId: string;
    attemptId: string;
    reason?: string;
  };
  CORPUS_WRITE_COMPLETED: {
    draftId: string;
    attemptId: string;
    corpusId: string;
    bodySha256: string;
    writtenAt: string;
  };
  UPSTREAM_FORWARD_FAILED: {
    upstream: string;
    statusCode?: number;
    error: string;
  };
}

export interface AuditEvent<K extends AuditEventType = AuditEventType> {
  PK: string;
  SK: string;
  action_type: K;
  attempt_id: string;
  actor_user_id: string;
  timestamp: string;
  details: AuditDetailsByType[K];
  TTL: number;
}
