/**
 * Canonical metric names. Registering these as constants keeps emission
 * sites coherent and makes grep audits trivial.
 */
export const MetricNames = {
  DetectionBlocked: "palisade.detection.blocked",
  DetectionAllowed: "palisade.detection.allowed",
  LayerLatencyMs: "palisade.layer.latency_ms",
  LayerOutcome: "palisade.layer.outcome",
  UpstreamLatencyMs: "palisade.upstream.latency_ms",
  SemanticCacheHit: "palisade.semantic_cache.hit",
  SemanticCacheMiss: "palisade.semantic_cache.miss",
  RateLimitEscalated: "palisade.rate_limit.escalated",
  HoneypotHit: "palisade.honeypot.hit",
  GateApproved: "palisade.gate.approved",
  GateRejected: "palisade.gate.rejected",
  GateVerificationFailed: "palisade.gate.verification_failed",
  CorpusWriteCompleted: "palisade.corpus.write_completed",
  AuditWriteFailed: "palisade.audit.write_failed",
  AttackLogFanoutFailed: "palisade.attack_log.fanout_failed",
} as const;

export type MetricName = (typeof MetricNames)[keyof typeof MetricNames];
