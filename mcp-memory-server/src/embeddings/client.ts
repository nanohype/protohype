/**
 * Embedding client — invokes the embedding Lambda function to compute
 * sentence embeddings via sentence-transformers (all-MiniLM-L6-v2).
 *
 * Falls back gracefully when no embedding function is configured (text-only mode).
 */
import {
  LambdaClient,
  InvokeCommand,
  InvokeCommandInput,
} from "@aws-sdk/client-lambda";

const lambdaClient = new LambdaClient({});

const EMBEDDING_FUNCTION_ARN = process.env.EMBEDDING_FUNCTION_ARN ?? "";

export interface EmbedRequest {
  texts: string[];
}

export interface EmbedResponse {
  embeddings: number[][];
}

/**
 * Returns embeddings for each input text.
 * Returns empty arrays if no embedding function is configured.
 */
export async function computeEmbeddings(texts: string[]): Promise<number[][]> {
  if (!EMBEDDING_FUNCTION_ARN) {
    // Text-only mode — semantic search will be unavailable
    return texts.map(() => []);
  }

  const payload: EmbedRequest = { texts };

  const params: InvokeCommandInput = {
    FunctionName: EMBEDDING_FUNCTION_ARN,
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify(payload)),
  };

  const response = await lambdaClient.send(new InvokeCommand(params));

  if (response.FunctionError) {
    throw new Error(
      `Embedding function error: ${response.FunctionError} — ` +
        Buffer.from(response.Payload ?? []).toString()
    );
  }

  const result: EmbedResponse = JSON.parse(
    Buffer.from(response.Payload ?? []).toString()
  );

  return result.embeddings;
}

/**
 * Compute cosine similarity between two equal-length vectors.
 * Returns 0 if either vector is empty (no embeddings available).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
