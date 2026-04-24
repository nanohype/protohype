import type { Identity } from "./identity.js";

/**
 * Supported upstream shapes. Palisade reverse-proxies requests in one of
 * these shapes; the detection pipeline runs against the normalized prompt
 * regardless of origin shape.
 */
export type UpstreamShape = "openai-chat" | "anthropic-messages" | "bedrock-invoke";

/**
 * Normalized prompt — the canonical input to every detection layer.
 * Origin-shape fidelity is retained via `rawRequest` for the forward step
 * but detection never reads from it.
 */
export interface NormalizedPrompt {
  /** The user-visible text content, concatenated across all message roles we inspect. */
  readonly text: string;
  /** Per-role snapshot of content so layer-specific logic can target `user` only if desired. */
  readonly segments: ReadonlyArray<{ role: string; text: string }>;
  /** Upstream target — determines forward endpoint. */
  readonly upstream: UpstreamShape;
  /** Canonical origin metadata for rate-limiting + audit trail. */
  readonly identity: Identity;
  /** Optional content-hash for semantic-cache keying. Computed at ingestion. */
  readonly promptHash: string;
  /** Request trace ID — flows through every span and error response. */
  readonly traceId: string;
  /** Headers as a lowercase-keyed snapshot (PII-shaped values scrubbed on archive). */
  readonly headers: Readonly<Record<string, string>>;
  /** Opaque raw request (preserved for forwarding only; never read by detection). */
  readonly rawBody: Uint8Array;
}
