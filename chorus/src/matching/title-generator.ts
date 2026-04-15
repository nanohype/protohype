import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { BedrockPort } from './embedder.js';
import type { RedactedText } from './redacted-text.js';

const MODEL_ID = process.env['TITLE_GEN_MODEL_ID'] ?? 'anthropic.claude-haiku-4-5-20251001-v1:0';

const SYSTEM =
  'You are a product management assistant. Generate a concise, neutral feature-request title from customer feedback. Rules: output ONLY the title (max 10 words, no punctuation at end, no quotes). Use gerund form. No proper nouns.';

interface ClaudeResponse {
  content?: Array<{ text?: string }>;
}

export interface TitleGeneratorDeps {
  bedrock: BedrockPort;
  modelId?: string;
}

function defaultBedrock(): BedrockPort {
  return new BedrockRuntimeClient({
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    maxAttempts: 3,
  });
}

function decode(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  throw new Error('title-generator: unsupported Bedrock body type');
}

export function createTitleGenerator(
  deps: Partial<TitleGeneratorDeps> = {},
): (text: RedactedText) => Promise<string> {
  const bedrock = deps.bedrock ?? defaultBedrock();
  const modelId = deps.modelId ?? MODEL_ID;

  return async (feedbackText) => {
    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 50,
      temperature: 0.2,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Customer feedback:\n"""\n${feedbackText.slice(0, 1000)}\n"""\n\nGenerate title:`,
        },
      ],
    };
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
      }),
    );
    const body = JSON.parse(decode(response.body)) as ClaudeResponse;
    const raw = body.content?.[0]?.text?.trim() ?? 'Untitled feature request';
    return raw.replace(/^["']|["']$/g, '').trim();
  };
}

/** Default singleton wired to the real Bedrock client. */
export const generateDraftTitle = createTitleGenerator();
