import type { RuleChange } from "../crawlers/types.js";
import type { ClientConfig } from "../clients/types.js";

// ── LLM provider port ──────────────────────────────────────────────
//
// Direct-SDK LLM abstraction used by classifier and memo drafter.
// Watchtower intentionally does NOT use `module-llm-providers` —
// every protohype subsystem calls Bedrock directly via a typed port
// and injects the SDK client at wiring time.
//

export interface LlmGenerateOptions {
  readonly system: string;
  readonly user: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
}

export interface LlmResult {
  readonly text: string;
  readonly stopReason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface LlmProvider {
  readonly modelId: string;
  generate(options: LlmGenerateOptions): Promise<LlmResult>;
}

// ── Classifier contract ────────────────────────────────────────────
//
// `ClassifierResult` is the canonical envelope the classify stage
// handoff emits. `disposition` is the triage decision that drives
// downstream routing:
//   - alert   → memo drafter + notify (score ≥ auto-alert threshold)
//   - review  → human-review queue (score between review and alert)
//   - drop    → no alert, record only (score < review threshold)
//
// `failureMode` is set when the LLM call failed and the result was
// synthesized by the fail-secure path — it always routes to review,
// never drops silently. Downstream code can log a metric on this.
//

export type Disposition = "drop" | "review" | "alert";
export type Confidence = "low" | "medium" | "high";
export type FailureMode = "timeout" | "schema" | "llm-error";

export interface ClassifierResult {
  readonly sourceId: string;
  readonly ruleChangeId: string;
  readonly clientId: string;
  readonly applicable: boolean;
  readonly score: number; // 0–100
  readonly confidence: Confidence;
  readonly rationale: string;
  readonly disposition: Disposition;
  readonly model: string;
  readonly failureMode?: FailureMode;
}

export interface ClassifierPort {
  classify(input: {
    readonly change: RuleChange;
    readonly client: ClientConfig;
  }): Promise<ClassifierResult>;
}
