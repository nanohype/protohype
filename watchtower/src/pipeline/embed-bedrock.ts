import { InvokeModelCommand, type BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { Logger } from "../logger.js";
import type { EmbeddingPort } from "./types.js";

// ── Bedrock Titan embeddings ───────────────────────────────────────
//
// Titan Embed Text v2 returns 1024-dim vectors. The request body is
// `{ inputText: string }`; there's no batch endpoint on Bedrock, so
// batch calls are parallelized client-side with a small concurrency
// cap (avoids slamming the on-account inference quota).
//

export interface BedrockEmbeddingDeps {
  readonly bedrock: Pick<BedrockRuntimeClient, "send">;
  readonly modelId: string;
  readonly logger: Logger;
  readonly dimensions?: number;
  readonly concurrency?: number;
}

const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_CONCURRENCY = 4;

export function createBedrockEmbedder(deps: BedrockEmbeddingDeps): EmbeddingPort {
  const { bedrock, modelId, logger } = deps;
  const dimensions = deps.dimensions ?? DEFAULT_DIMENSIONS;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  async function embedOne(text: string): Promise<number[]> {
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({ inputText: text, dimensions }),
      }),
    );
    const bodyText = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(bodyText) as { embedding?: number[] };
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== dimensions) {
      logger.error("bedrock titan returned malformed embedding", {
        modelId,
        receivedLength: Array.isArray(parsed.embedding) ? parsed.embedding.length : null,
      });
      throw new Error("bedrock titan returned malformed embedding");
    }
    return parsed.embedding;
  }

  return {
    dimensions,
    modelId,
    async embed(texts) {
      const results = new Array<number[]>(texts.length);
      // Simple bounded-concurrency fan-out.
      let cursor = 0;
      async function worker(): Promise<void> {
        while (true) {
          const i = cursor++;
          if (i >= texts.length) return;
          results[i] = await embedOne(texts[i]!);
        }
      }
      const workers = Array.from({ length: Math.min(concurrency, texts.length) }, () => worker());
      await Promise.all(workers);
      return results;
    },
  };
}
