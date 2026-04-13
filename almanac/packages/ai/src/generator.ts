import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  ANSWER_GENERATOR_SYSTEM,
  QUERY_REWRITER_SYSTEM,
  buildAnswerPrompt,
} from './prompt-library.js';

const HAIKU_MODEL_ID = 'us.anthropic.claude-3-haiku-20240307-v1:0';
const MAX_ANSWER_TOKENS = 512;

export class AnswerGenerator {
  private client: BedrockRuntimeClient;

  constructor(client: BedrockRuntimeClient) {
    this.client = client;
  }

  async rewriteQuery(originalQuery: string): Promise<string> {
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 128,
      temperature: 0,
      system: QUERY_REWRITER_SYSTEM,
      messages: [{ role: 'user', content: originalQuery }],
    });
    const command = new InvokeModelCommand({
      modelId: HAIKU_MODEL_ID,
      body: Buffer.from(body),
      contentType: 'application/json',
      accept: 'application/json',
    });
    const response = await this.client.send(command);
    const parsed = JSON.parse(Buffer.from(response.body).toString());
    return (parsed.content?.[0]?.text ?? originalQuery).trim();
  }

  async generateAnswer(
    rewrittenQuery: string,
    chunks: Array<{ title: string; source: string; content: string }>,
  ): Promise<string> {
    if (chunks.length === 0) {
      return "I couldn't find a document in your accessible spaces that answers this.";
    }
    const prompt = buildAnswerPrompt(rewrittenQuery, chunks);
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: MAX_ANSWER_TOKENS,
      temperature: 0.1,
      top_p: 0.9,
      system: ANSWER_GENERATOR_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
    const command = new InvokeModelCommand({
      modelId: HAIKU_MODEL_ID,
      body: Buffer.from(body),
      contentType: 'application/json',
      accept: 'application/json',
    });
    const response = await this.client.send(command);
    const parsed = JSON.parse(Buffer.from(response.body).toString());
    return (parsed.content?.[0]?.text ?? '').trim();
  }
}
