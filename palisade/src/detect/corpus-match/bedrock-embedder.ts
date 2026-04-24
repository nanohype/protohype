import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { EmbeddingPort } from "../../ports/index.js";

export interface BedrockEmbedderDeps {
  readonly client: BedrockRuntimeClient;
  readonly modelId: string;
}

/**
 * Titan embedding wrapper. Returns a Float32Array for efficient cosine
 * math downstream. Input truncation is Bedrock's job — we don't pre-trim.
 */
export function createBedrockEmbedder(deps: BedrockEmbedderDeps): EmbeddingPort {
  return {
    async embed(text: string): Promise<Float32Array> {
      const response = await deps.client.send(
        new InvokeModelCommand({
          modelId: deps.modelId,
          contentType: "application/json",
          accept: "application/json",
          body: new TextEncoder().encode(JSON.stringify({ inputText: text })),
        }),
      );
      const body = JSON.parse(new TextDecoder().decode(response.body)) as { embedding?: unknown };
      if (!Array.isArray(body.embedding)) throw new Error("Embedder returned no embedding array");
      const arr = new Float32Array(body.embedding.length);
      for (let i = 0; i < body.embedding.length; i++) {
        const v = body.embedding[i];
        arr[i] = typeof v === "number" ? v : 0;
      }
      return arr;
    },
  };
}
