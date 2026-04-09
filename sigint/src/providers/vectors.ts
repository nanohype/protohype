import type { Config } from "../config.js";
import { createRegistry } from "./registry.js";

export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, string>;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, string>;
}

export interface VectorStore {
  upsert(docs: VectorDocument[]): Promise<void>;
  search(embedding: number[], topK: number, filter?: Record<string, string>): Promise<SearchResult[]>;
  delete(ids: string[]): Promise<void>;
  deleteByMetadata(filter: Record<string, string>): Promise<number>;
  count(): Promise<number>;
}

// ─── Cosine similarity ───

function cosine(a: number[], b: number[]): number {
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

// ─── In-Memory ───
// All data lives in process memory — lost on restart.
// Use for development/testing. Switch to pgvector for persistence.

class MemoryVectorStore implements VectorStore {
  private docs = new Map<string, VectorDocument>();

  async upsert(docs: VectorDocument[]): Promise<void> {
    for (const doc of docs) {
      this.docs.set(doc.id, doc);
    }
  }

  async search(
    embedding: number[],
    topK: number,
    filter?: Record<string, string>,
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const doc of this.docs.values()) {
      if (filter) {
        const matches = Object.entries(filter).every(([k, v]) => doc.metadata[k] === v);
        if (!matches) continue;
      }
      results.push({
        id: doc.id,
        content: doc.content,
        score: cosine(embedding, doc.embedding),
        metadata: doc.metadata,
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.docs.delete(id);
  }

  async deleteByMetadata(filter: Record<string, string>): Promise<number> {
    let deleted = 0;
    for (const [id, doc] of this.docs) {
      const matches = Object.entries(filter).every(([k, v]) => doc.metadata[k] === v);
      if (matches) {
        this.docs.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  async count(): Promise<number> {
    return this.docs.size;
  }
}

// ─── Registry ───

export const vectorRegistry = createRegistry<VectorStore>("vector-store");

export function bootstrapVectorStore(config: Config): VectorStore {
  vectorRegistry.register("memory", () => new MemoryVectorStore());
  return vectorRegistry.get(config.vectorProvider);
}
