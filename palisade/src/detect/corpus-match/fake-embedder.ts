import { createHash } from "node:crypto";
import type { EmbeddingPort } from "../../ports/index.js";

/**
 * Deterministic in-process embedder for tests + local dev. Hashes the input
 * text into a fixed-dimension Float32Array. Not semantically meaningful —
 * only useful for exercising the corpus-match layer's plumbing.
 */
export function createFakeEmbedder(dimensions = 256): EmbeddingPort {
  return {
    async embed(text: string): Promise<Float32Array> {
      const arr = new Float32Array(dimensions);
      const digest = createHash("sha256").update(text, "utf8").digest();
      for (let i = 0; i < dimensions; i++) {
        arr[i] = (digest[i % digest.length] ?? 0) / 255 - 0.5;
      }
      return normalize(arr);
    },
  };
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] ?? 0) * (v[i] ?? 0);
  const mag = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / mag;
  return v;
}
