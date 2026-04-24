import type { LlmProvider, LlmResult } from "./types.js";

// ── In-memory LLM fake ─────────────────────────────────────────────
//
// Test double for `LlmProvider`. Takes a fixed script of responses
// (or a responder function) so tests can exercise specific classifier
// behavior without hitting Bedrock.
//

export interface FakeLlmScript {
  /** Hardcoded string returned for every call. */
  readonly text?: string;
  /** Responder receives the options; wins over `text` when set. */
  readonly respond?: (opts: {
    readonly system: string;
    readonly user: string;
  }) => Promise<string> | string;
  /** Synthesizes a failure on every call. */
  readonly failWith?: Error;
  /** Model ID reported by the provider. */
  readonly modelId?: string;
}

export function createFakeLlm(script: FakeLlmScript = {}): LlmProvider {
  const modelId = script.modelId ?? "fake-claude";
  return {
    modelId,
    async generate(options): Promise<LlmResult> {
      if (script.failWith) throw script.failWith;
      let text = script.text ?? "";
      if (script.respond) {
        text = await script.respond({ system: options.system, user: options.user });
      }
      return { text };
    },
  };
}
