import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { PII_CLASSIFIER_PROMPT } from './prompt-library.js';
import type { PiiCheckResult } from './types.js';

const HAIKU_MODEL_ID = 'us.anthropic.claude-3-haiku-20240307-v1:0';

// Fast regex pre-filter before LLM check (cost guard)
const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // email
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, // US phone
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
];

export class PiiGuard {
  private client: BedrockRuntimeClient;

  constructor(client: BedrockRuntimeClient) {
    this.client = client;
  }

  async check(text: string): Promise<PiiCheckResult> {
    // Fast regex pre-filter
    for (const pattern of PII_PATTERNS) {
      if (pattern.test(text)) {
        return { containsPii: true, piiTypes: ['regex_match'] };
      }
    }

    // LLM classifier for edge cases
    const prompt = PII_CLASSIFIER_PROMPT(text);
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 64,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const command = new InvokeModelCommand({
      modelId: HAIKU_MODEL_ID,
      body: Buffer.from(body),
      contentType: 'application/json',
      accept: 'application/json',
    });

    const response = await this.client.send(command);
    const raw = JSON.parse(Buffer.from(response.body).toString());
    const content = raw.content?.[0]?.text ?? '{}';

    try {
      const parsed = JSON.parse(content) as PiiCheckResult;
      return parsed;
    } catch {
      return { containsPii: false, piiTypes: [] };
    }
  }
}
