/**
 * Bedrock client wrapper.
 *
 * - Primary model: claude-sonnet-4-6 (most work)
 * - Escalation: claude-opus-4-6 (complex migration synthesis)
 * - Light: claude-haiku-4-5 (changelog classification, routing)
 *
 * - Inference logging: NONE — set at deploy time via CDK; NOT commented-out.
 * - Auth: IAM role-based — no API keys.
 * - Prompt caching: mandatory — cachePoint markers on stable context prefixes.
 * - Per-call timeout: 30 seconds.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

const REGION = process.env.AWS_REGION ?? 'us-west-2';

export const MODELS = {
  DEFAULT:    'anthropic.claude-sonnet-4-6',
  ESCALATION: 'anthropic.claude-opus-4-6',
  LIGHT:      'anthropic.claude-haiku-4-5',
} as const;
export type ModelId = typeof MODELS[keyof typeof MODELS];

const bedrockClient = new BedrockRuntimeClient({
  region: REGION,
  requestHandler: {
    requestTimeout: 30_000,   // 30s — never default-infinity
  } as { requestTimeout: number },
});

export interface ConverseParams {
  modelId: ModelId;
  systemPrompt: string;
  userMessage: string;
  /** If true, marks the system prompt with a cachePoint block. */
  cacheSystemPrompt?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface ConverseResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Invoke a Bedrock Converse request.
 * Uses cachePoint on the system prompt when cacheSystemPrompt=true.
 */
export async function converse(params: ConverseParams): Promise<ConverseResult> {
  const systemBlocks: SystemContentBlock[] = [
    { text: params.systemPrompt },
  ];

  if (params.cacheSystemPrompt) {
    // Append a cachePoint after the stable system prompt to enable prompt caching.
    // The cachePoint marker signals Bedrock to cache everything up to this point.
    systemBlocks.push({ cachePoint: { type: 'default' } });
  }

  const messages: Message[] = [
    { role: 'user', content: [{ text: params.userMessage }] },
  ];

  const cmd = new ConverseCommand({
    modelId: params.modelId,
    system: systemBlocks,
    messages,
    inferenceConfig: {
      maxTokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.1,
    },
  });

  const resp = await bedrockClient.send(cmd);

  const output = resp.output?.message?.content ?? [];
  const text = output
    .filter((b): b is { text: string } => 'text' in b)
    .map((b) => b.text)
    .join('');

  const usage = resp.usage ?? {};
  return {
    content: text,
    inputTokens: (usage as { inputTokens?: number }).inputTokens ?? 0,
    outputTokens: (usage as { outputTokens?: number }).outputTokens ?? 0,
    cacheReadTokens: (usage as { cacheReadInputTokens?: number }).cacheReadInputTokens ?? 0,
    cacheWriteTokens: (usage as { cacheWriteInputTokens?: number }).cacheWriteInputTokens ?? 0,
  };
}
