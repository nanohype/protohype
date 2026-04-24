import { z } from "zod";
import type { NormalizedPrompt, UpstreamShape } from "../types/prompt.js";
import type { Identity } from "../types/identity.js";
import { promptFingerprint, sha256Hex } from "../util/hash.js";

// ── Schemas per upstream shape ───────────────────────────────────────

const openAiMessage = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
});

const openAiChatSchema = z.object({
  model: z.string().optional(),
  messages: z.array(openAiMessage),
});

const anthropicContentBlock = z.object({ type: z.string(), text: z.string().optional() });
const anthropicMessage = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(anthropicContentBlock)]),
});

const anthropicMessagesSchema = z.object({
  model: z.string().optional(),
  system: z.union([z.string(), z.array(anthropicContentBlock)]).optional(),
  messages: z.array(anthropicMessage),
});

const bedrockInvokeSchema = z.object({
  // Bedrock passes through the model-native body — we treat the whole JSON as
  // the prompt for detection. Concrete shapes (claude-messages, titan, etc)
  // are all stringified for heuristic/classifier consumption.
  body: z.unknown(),
});

// ── Flatten helpers ──────────────────────────────────────────────────

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "object" && block && "text" in block && typeof block.text === "string" ? block.text : ""))
      .join("\n");
  }
  return "";
}

function flattenBedrockBody(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

// ── Public API ───────────────────────────────────────────────────────

export interface NormalizeInput {
  readonly upstream: UpstreamShape;
  readonly rawBody: Uint8Array;
  readonly headers: Record<string, string>;
  readonly identity: Identity;
  readonly traceId: string;
}

export function normalize(input: NormalizeInput): NormalizedPrompt {
  const textBody = new TextDecoder().decode(input.rawBody);
  let parsed: unknown;
  try {
    parsed = textBody ? JSON.parse(textBody) : {};
  } catch {
    parsed = {};
  }

  const segments: Array<{ role: string; text: string }> = [];

  switch (input.upstream) {
    case "openai-chat": {
      const result = openAiChatSchema.safeParse(parsed);
      if (result.success) {
        for (const m of result.data.messages) {
          segments.push({ role: m.role, text: flattenContent(m.content) });
        }
      }
      break;
    }
    case "anthropic-messages": {
      const result = anthropicMessagesSchema.safeParse(parsed);
      if (result.success) {
        if (result.data.system) {
          segments.push({ role: "system", text: flattenContent(result.data.system) });
        }
        for (const m of result.data.messages) {
          segments.push({ role: m.role, text: flattenContent(m.content) });
        }
      }
      break;
    }
    case "bedrock-invoke": {
      const result = bedrockInvokeSchema.safeParse({ body: parsed });
      if (result.success) {
        segments.push({ role: "bedrock", text: flattenBedrockBody(result.data.body) });
      }
      break;
    }
  }

  const text = segments
    .map((s) => s.text)
    .join("\n")
    .trim();

  return {
    text,
    segments,
    upstream: input.upstream,
    identity: input.identity,
    promptHash: promptFingerprint(text || textBody),
    traceId: input.traceId,
    headers: Object.freeze({ ...input.headers }),
    rawBody: input.rawBody,
  };
}

/** SHA-256 over the prompt text, full width — used for audit fingerprinting. */
export function fullPromptSha256(prompt: NormalizedPrompt): string {
  return sha256Hex(prompt.text);
}
