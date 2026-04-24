import { InvokeModelCommand, type BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { Logger } from "../logger.js";
import type { LlmGenerateOptions, LlmProvider, LlmResult } from "./types.js";

// ── Bedrock Claude provider ────────────────────────────────────────
//
// Implements the LlmProvider port for Anthropic Claude via the
// cross-region inference profile format (`us.anthropic.claude-…`).
// The request schema is the Bedrock-hosted Claude messages format.
//

const ANTHROPIC_BEDROCK_VERSION = "bedrock-2023-05-31";
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BedrockLlmDeps {
  readonly bedrock: Pick<BedrockRuntimeClient, "send">;
  readonly modelId: string;
  readonly logger: Logger;
  readonly defaultTimeoutMs?: number;
}

interface AnthropicResponseBody {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly stop_reason?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

export function createBedrockLlm(deps: BedrockLlmDeps): LlmProvider {
  const { bedrock, modelId, logger } = deps;
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    modelId,
    async generate(options: LlmGenerateOptions): Promise<LlmResult> {
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
      const body = {
        anthropic_version: ANTHROPIC_BEDROCK_VERSION,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        system: options.system,
        messages: [{ role: "user", content: options.user }],
      };
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await bedrock.send(
        new InvokeModelCommand({
          modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(body),
        }),
        { abortSignal: signal },
      );
      const raw = new TextDecoder().decode(response.body);
      let parsed: AnthropicResponseBody;
      try {
        parsed = JSON.parse(raw) as AnthropicResponseBody;
      } catch (err) {
        logger.error("bedrock returned non-JSON body", {
          modelId,
          preview: raw.slice(0, 200),
          error: err instanceof Error ? err.message : String(err),
        });
        throw new Error("bedrock returned non-JSON body");
      }
      const text = (parsed.content ?? [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      const result: LlmResult = {
        text,
        ...(parsed.stop_reason !== undefined ? { stopReason: parsed.stop_reason } : {}),
        ...(parsed.usage?.input_tokens !== undefined
          ? { inputTokens: parsed.usage.input_tokens }
          : {}),
        ...(parsed.usage?.output_tokens !== undefined
          ? { outputTokens: parsed.usage.output_tokens }
          : {}),
      };
      return result;
    },
  };
}
