/**
 * Shared Bedrock Converse client for all Kiln AI stages.
 *
 * - IAM role-based auth (no API keys).
 * - Prompt caching mandatory: stable system prompts get a cachePoint marker.
 * - Explicit per-call timeout: 30 s (per security requirements).
 * - Model routing: classify → Haiku, default → Sonnet, complex → Opus.
 * - Inference logging disabled at the model level (NONE) per security policy;
 *   enforcement verified via CloudTrail at deploy time.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ContentBlock,
  type SystemContentBlock,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import type { KilnModelTier, LLMTokenUsage } from './types.js';

// ─── Model IDs ───────────────────────────────────────────────────────────────

const MODEL_IDS: Record<KilnModelTier, string> = {
  classify: process.env['KILN_MODEL_CLASSIFY'] ?? 'anthropic.claude-haiku-4-5',
  default: process.env['KILN_MODEL_DEFAULT'] ?? 'anthropic.claude-sonnet-4-6',
  complex: process.env['KILN_MODEL_COMPLEX'] ?? 'anthropic.claude-opus-4-6',
};

// ─── Bedrock client (singleton per region) ───────────────────────────────────

let _client: BedrockRuntimeClient | null = null;

export function getBedrockClient(): BedrockRuntimeClient {
  if (!_client) {
    _client = new BedrockRuntimeClient({
      region: process.env['AWS_REGION'] ?? 'us-west-2',
      // Timeout applied per-request via AbortSignal below — SDK-level timeout
      // covers connection establishment only.
      requestHandler: {
        requestTimeout: 35_000, // ms — slightly above the 30 s per-call budget
        connectionTimeout: 5_000,
      } as ConstructorParameters<typeof BedrockRuntimeClient>[0]['requestHandler'],
    });
  }
  return _client;
}

/** Inject for testing — replaces the singleton. */
export function setBedrockClient(client: BedrockRuntimeClient): void {
  _client = client;
}

// ─── Prompt caching helpers ───────────────────────────────────────────────────

/** Append a cache-point marker after the stable system prompt text. */
export function withSystemCachePoint(text: string): SystemContentBlock[] {
  return [
    { text },
    // The cache-point block tells Bedrock to cache everything before this
    // marker; subsequent calls with the same prefix hit the cache.
    { cachePoint: { type: 'default' } } as unknown as SystemContentBlock,
  ];
}

/** Append a cache-point marker after stable context in a user turn. */
export function withContentCachePoint(
  stableContent: string,
  dynamicContent: string,
): ContentBlock[] {
  return [
    { text: stableContent },
    { cachePoint: { type: 'default' } } as unknown as ContentBlock,
    { text: dynamicContent },
  ];
}

// ─── Zero usage constant ─────────────────────────────────────────────────────

export function zeroUsage(): LLMTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
}

// ─── Core converse call ──────────────────────────────────────────────────────

export interface ConverseOptions {
  tier: KilnModelTier;
  system: SystemContentBlock[];
  messages: Message[];
  maxTokens?: number;
}

export interface ConverseResult {
  text: string;
  usage: LLMTokenUsage;
}

/**
 * Single Bedrock Converse call with a 30 s hard timeout.
 * Returns the assistant's text content and full token usage (including cache
 * read/write counts for cache-hit ratio tracking).
 */
export async function converse(opts: ConverseOptions): Promise<ConverseResult> {
  const client = getBedrockClient();

  const input: ConverseCommandInput = {
    modelId: MODEL_IDS[opts.tier],
    system: opts.system,
    messages: opts.messages,
    inferenceConfig: {
      maxTokens: opts.maxTokens ?? 4096,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  let response;
  try {
    response = await client.send(new ConverseCommand(input), {
      abortSignal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      const e = new Error('Bedrock converse call timed out after 30 s');
      (e as NodeJS.ErrnoException).code = 'LLM_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const outputMessage = response.output?.message;
  const textBlock = outputMessage?.content?.find((b) => 'text' in b && typeof b.text === 'string');
  const text = (textBlock as { text: string } | undefined)?.text ?? '';

  const usage = response.usage ?? {};
  return {
    text,
    usage: {
      inputTokens: (usage as Record<string, number>)['inputTokens'] ?? 0,
      outputTokens: (usage as Record<string, number>)['outputTokens'] ?? 0,
      cacheReadInputTokens: (usage as Record<string, number>)['cacheReadInputTokens'] ?? 0,
      cacheWriteInputTokens: (usage as Record<string, number>)['cacheWriteInputTokens'] ?? 0,
    },
  };
}

// ─── Usage accumulator ───────────────────────────────────────────────────────

export function addUsage(a: LLMTokenUsage, b: LLMTokenUsage): LLMTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
  };
}

export function cacheHitRatio(usage: LLMTokenUsage): number {
  const denominator = usage.inputTokens + usage.cacheReadInputTokens;
  if (denominator === 0) return 0;
  return usage.cacheReadInputTokens / denominator;
}

// ─── JSON extraction helper ───────────────────────────────────────────────────

/**
 * Extract a JSON block from LLM output. The model often wraps JSON in
 * ``` fences or adds preamble text — this strips those before parsing.
 */
export function extractJson<T>(raw: string): T {
  // Strip markdown code fences if present
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1] : raw;

  // Find the outermost JSON object or array
  const objMatch = jsonStr?.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!objMatch) {
    throw new Error(`LLM output contained no parseable JSON: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(objMatch[0]) as T;
}
