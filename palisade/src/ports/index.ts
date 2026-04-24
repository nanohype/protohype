/**
 * All port interfaces live here. These are the DI surface of palisade —
 * `src/index.ts` constructs concrete implementations and injects them into
 * every service. A client fork replaces the implementations, not the shape.
 *
 * Each port is minimal: only the operations palisade actually calls.
 */

import type { AttackTaxonomy, ApprovedSample, CorpusMatch } from "../types/corpus.js";
import type { AuditDetailsByType, AuditEventType, AuditEvent } from "../types/audit.js";
import type { LabelDraft } from "../types/label.js";
import type { LayerVerdict } from "../types/verdict.js";
import type { NormalizedPrompt } from "../types/prompt.js";
import type { Identity } from "../types/identity.js";

// ── Upstream ─────────────────────────────────────────────────────────

export interface UpstreamResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: ReadableStream<Uint8Array> | Uint8Array | null;
}

export interface LlmUpstreamPort {
  forward(prompt: NormalizedPrompt): Promise<UpstreamResponse>;
}

// ── Detection layers ─────────────────────────────────────────────────

export interface DetectionLayerPort {
  readonly name: "heuristics" | "classifier" | "corpus-match";
  detect(prompt: NormalizedPrompt): Promise<LayerVerdict>;
}

// ── Corpus ───────────────────────────────────────────────────────────

/** Public, hot-path read side of the corpus. */
export interface CorpusReadPort {
  search(embedding: Float32Array, topK: number): Promise<CorpusMatch[]>;
}

/**
 * PROTECTED write side of the corpus. Only `src/gate/label-approval-gate.ts`
 * may import this. CI grep rule enforces the invariant.
 */
export interface CorpusWritePort {
  addAttack(sample: ApprovedSample): Promise<void>;
}

// ── Embedding ────────────────────────────────────────────────────────

export interface EmbeddingPort {
  embed(text: string): Promise<Float32Array>;
}

// ── Classifier ───────────────────────────────────────────────────────

export interface ClassifierVerdict {
  /** Probability that the prompt is malicious (0..1). */
  readonly score: number;
  /** Optional short label for audit only; never returned to caller. */
  readonly label?: string;
}

export interface ClassifierPort {
  classify(prompt: NormalizedPrompt): Promise<ClassifierVerdict>;
}

// ── Audit log ────────────────────────────────────────────────────────

export interface AuditLogPort {
  write<K extends AuditEventType>(attemptId: string, actor: string, type: K, details: AuditDetailsByType[K]): Promise<void>;
  verifyApproval(attemptId: string): Promise<void>;
  query(attemptId: string): Promise<AuditEvent[]>;
}

// ── Label queue ──────────────────────────────────────────────────────

export interface LabelQueuePort {
  enqueue(draft: LabelDraft): Promise<void>;
  get(draftId: string): Promise<LabelDraft | null>;
  markApproved(draftId: string, approver: string): Promise<void>;
  markRejected(draftId: string, rejector: string, reason?: string): Promise<void>;
  list(status: LabelDraft["status"]): Promise<LabelDraft[]>;
}

// ── Rate limiter ─────────────────────────────────────────────────────

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
}

export interface RateLimiterPort {
  check(identity: Identity): Promise<RateLimitDecision>;
  /** Record a hard-block signal so future requests from this identity are throttled. */
  escalate(identity: Identity, severity: "soft" | "hard"): Promise<void>;
}

// ── Semantic cache ───────────────────────────────────────────────────

export interface CachedVerdict {
  readonly outcome: "BENIGN" | "MALICIOUS";
  readonly blockingLayer?: string;
}

export interface SemanticCachePort {
  get(promptHash: string): Promise<CachedVerdict | null>;
  set(promptHash: string, verdict: CachedVerdict, ttlSeconds: number): Promise<void>;
}

// ── Async attack-log sink (SQS fan-out) ──────────────────────────────

export interface AttackLogRecord {
  readonly attemptId: string;
  readonly identity: Identity;
  readonly promptSha256: string;
  readonly promptText: string;
  readonly verdict: "BLOCKED" | "ALLOWED" | "HONEYPOT_HIT";
  readonly blockingLayer?: string;
  readonly layerScores?: Record<string, number>;
  readonly upstream?: string;
  readonly timestamp: string;
}

export interface AttackLogSinkPort {
  send(record: AttackLogRecord): Promise<void>;
}

// ── Honeypot ─────────────────────────────────────────────────────────

export interface HoneypotRecord {
  readonly attemptId: string;
  readonly endpoint: string;
  readonly identity: Identity;
  readonly fingerprint: string;
  readonly promptText: string;
  readonly bodyLength: number;
  readonly timestamp: string;
}

export interface HoneypotSinkPort {
  send(record: HoneypotRecord): Promise<void>;
}

// ── Metrics + tracing (thin facades over OTel) ───────────────────────

export interface MetricsPort {
  counter(name: string, value?: number, attributes?: Record<string, string | number>): void;
  histogram(name: string, value: number, attributes?: Record<string, string | number>): void;
}

export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
}

export interface TracerPort {
  withSpan<T>(name: string, attributes: Record<string, string | number | boolean>, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
}

// ── Taxonomy (re-exported so call sites don't reach into types/) ─────

export type { AttackTaxonomy };
