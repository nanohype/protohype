// Bedrock LLM adapter. Prompts are built in core/ai; this module shuttles
// them to Bedrock and parses responses.

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { parseClassifyOutput, parseSynthesizeOutput } from "../../core/ai/guardrails.js";
import { classifierPrompt, synthesizerPrompt } from "../../core/ai/prompts.js";
import type { ClassifyInput, ClassifyOutput, LlmModel, LlmPort, SynthesizeInput, SynthesizeOutput } from "../../core/ports.js";
import { err, ok, type DomainError, type Result } from "../../types.js";

export interface BedrockAdapterConfig {
  region: string;
  classifierModel: string;
  synthesizerModel: string;
  synthesizerEscalationModel: string;
  timeoutMs: number;
}

export function makeBedrockAdapter(cfg: BedrockAdapterConfig): LlmPort {
  const client = new BedrockRuntimeClient({ region: cfg.region });

  // Returns a Result so callers can distinguish transport failures (Upstream,
  // Timeout) from "Bedrock gave us something we can't parse" (Validation).
  // Neither kind should ever throw past this function.
  const invoke = async (
    modelId: string,
    prompt: { system: string; user: string },
    source: string,
  ): Promise<Result<string, DomainError>> => {
    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4096,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const resp = await client.send(
        new InvokeModelCommand({
          modelId,
          contentType: "application/json",
          accept: "application/json",
          body,
        }),
        { abortSignal: controller.signal },
      );
      const payload = new TextDecoder().decode(resp.body);
      let parsed: { content?: Array<{ text?: string }> };
      try {
        parsed = JSON.parse(payload) as { content?: Array<{ text?: string }> };
      } catch (e) {
        return err({
          kind: "Validation",
          message: `bedrock returned non-JSON payload: ${asMessage(e)}`,
          path: source,
        });
      }
      const text = parsed.content?.[0]?.text;
      if (typeof text !== "string") {
        return err({
          kind: "Validation",
          message: "bedrock response missing content[0].text",
          path: source,
        });
      }
      return ok(text);
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") {
        return err({ kind: "Timeout", source, timeoutMs: cfg.timeoutMs });
      }
      return err({ kind: "Upstream", source, message: asMessage(e) });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async classify(input: ClassifyInput): Promise<Result<ClassifyOutput>> {
      const rawResult = await invoke(cfg.classifierModel, classifierPrompt(input), "bedrock:classify");
      if (!rawResult.ok) return rawResult;
      try {
        return ok(parseClassifyOutput(rawResult.value));
      } catch (e) {
        return err({
          kind: "Validation",
          message: `classify guardrail rejected output: ${asMessage(e)}`,
          path: "bedrock:classify",
        });
      }
    },
    async synthesize(input: SynthesizeInput, model: LlmModel): Promise<Result<SynthesizeOutput>> {
      const modelId =
        model === "synthesizer-escalation"
          ? cfg.synthesizerEscalationModel
          : model === "classifier"
            ? cfg.classifierModel
            : cfg.synthesizerModel;
      const rawResult = await invoke(
        modelId,
        synthesizerPrompt({
          pkg: input.pkg,
          fromVersion: input.fromVersion,
          toVersion: input.toVersion,
          breakingChangeDescription: input.breakingChange.description,
          affectedSymbols: input.breakingChange.affectedSymbols,
          callSites: input.callSites.map((c) => ({ path: c.path, line: c.line, snippet: c.snippet })),
        }),
        "bedrock:synthesize",
      );
      if (!rawResult.ok) return rawResult;
      try {
        return ok(parseSynthesizeOutput(rawResult.value));
      } catch (e) {
        return err({
          kind: "Validation",
          message: `synthesize guardrail rejected output: ${asMessage(e)}`,
          path: "bedrock:synthesize",
        });
      }
    },
  };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
