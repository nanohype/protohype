import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { withCorrelation } from '../lib/observability.js';
import { auditLog, type AuditPort } from '../lib/audit.js';
import { awsRegion, AWS_MAX_ATTEMPTS } from '../lib/aws.js';
import type { RedactedText } from './redacted-text.js';

const EMBEDDING_MODEL_ID = process.env['EMBEDDING_MODEL_ID'] ?? 'amazon.titan-embed-text-v2:0';
const BATCH_SIZE = 20;

export interface EmbeddingResult {
  text: RedactedText;
  embedding: number[];
}

interface BedrockEmbeddingResponse {
  embedding?: unknown;
}

/**
 * Tiny port over the Bedrock SDK. Only the `send(InvokeModelCommand)`
 * shape we use, returning a body with the encoded JSON. Tests inject
 * a `vi.fn` returning a `{ body: Uint8Array }`-shaped object.
 */
export interface BedrockPort {
  send(command: InvokeModelCommand): Promise<{ body?: unknown }>;
}

export interface EmbedderDeps {
  bedrock: BedrockPort;
  audit: AuditPort;
  modelId?: string;
  batchSize?: number;
}

function defaultBedrock(): BedrockPort {
  return new BedrockRuntimeClient({ region: awsRegion(), maxAttempts: AWS_MAX_ATTEMPTS });
}

export interface Embedder {
  embedBatch(correlationIds: string[], texts: RedactedText[]): Promise<EmbeddingResult[]>;
  embedSingle(correlationId: string, text: RedactedText): Promise<number[]>;
}

export function createEmbedder(deps: Partial<EmbedderDeps> = {}): Embedder {
  const bedrock = deps.bedrock ?? defaultBedrock();
  const audit = deps.audit ?? auditLog;
  const modelId = deps.modelId ?? EMBEDDING_MODEL_ID;
  const batchSize = deps.batchSize ?? BATCH_SIZE;

  async function embedOne(text: RedactedText): Promise<number[]> {
    const body = JSON.stringify({ inputText: text, dimensions: 1024, normalize: true });
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body,
      }),
    );
    const raw = response.body;
    const decoded = decodeBedrockBody(raw);
    const parsed = JSON.parse(decoded) as BedrockEmbeddingResponse;
    if (!Array.isArray(parsed.embedding) || !parsed.embedding.every((n) => typeof n === 'number')) {
      throw new Error('Unexpected Bedrock response shape');
    }
    return parsed.embedding;
  }

  return {
    async embedBatch(correlationIds, texts) {
      const results: EmbeddingResult[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batchTexts = texts.slice(i, i + batchSize);
        const batchIds = correlationIds.slice(i, i + batchSize);
        const embeddings = await Promise.all(batchTexts.map((t) => embedOne(t)));
        for (let j = 0; j < batchTexts.length; j++) {
          const text = batchTexts[j];
          const embedding = embeddings[j];
          const id = batchIds[j];
          if (text === undefined || embedding === undefined || id === undefined) continue;
          results.push({ text, embedding });
          await audit({
            correlationId: id,
            stage: 'EMBED',
            detail: { modelId, dim: embedding.length },
          });
        }
      }
      return results;
    },

    async embedSingle(correlationId, text) {
      return withCorrelation(correlationId, 'EMBED', async () => {
        const [r] = await this.embedBatch([correlationId], [text]);
        if (!r) throw new Error('embedSingle: empty result');
        return r.embedding;
      });
    },
  };
}

function decodeBedrockBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body && typeof body === 'object' && 'transformToString' in body) {
    // The real SDK returns an SdkStream; production callers should
    // convert to Uint8Array before calling embedder.
    throw new Error('decodeBedrockBody: use transformToString in production wrapper');
  }
  throw new Error('decodeBedrockBody: unsupported body type');
}

/** Default singleton wired to the real Bedrock client + auditLog. */
const _default = createEmbedder();
export const embedBatch = _default.embedBatch.bind(_default);
export const embedSingle = _default.embedSingle.bind(_default);
