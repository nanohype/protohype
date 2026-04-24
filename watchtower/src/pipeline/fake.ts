import type { EmbeddingPort, VectorRow, VectorStorePort } from "./types.js";

// ── In-memory fakes for pipeline tests ─────────────────────────────
//
// Deterministic hash-based embedder: no LLM calls, stable across
// runs, same text → same vector. Good enough for dedup / upsert
// semantics. Real Bedrock is swapped in at wiring time.
//

export function createFakeEmbedder(dimensions = 8): EmbeddingPort {
  const embed = (text: string): number[] => {
    const out = new Array<number>(dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      out[i % dimensions]! += text.charCodeAt(i);
    }
    const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
    return out.map((x) => x / norm);
  };
  return {
    dimensions,
    modelId: "fake-embedder",
    async embed(texts) {
      return texts.map((t) => embed(t));
    },
  };
}

export interface FakeVectorStore extends VectorStorePort {
  readonly rows: readonly VectorRow[];
  clear(): void;
}

export function createFakeVectorStore(): FakeVectorStore {
  let rows: VectorRow[] = [];
  return {
    async upsert(newRows) {
      const ids = new Set(newRows.map((r) => r.id));
      rows = rows.filter((r) => !ids.has(r.id)).concat(newRows);
    },
    async deleteByRuleChange(sourceId, ruleChangeId) {
      rows = rows.filter((r) => !(r.sourceId === sourceId && r.ruleChangeId === ruleChangeId));
    },
    async countByRuleChange(sourceId, ruleChangeId) {
      return rows.filter((r) => r.sourceId === sourceId && r.ruleChangeId === ruleChangeId).length;
    },
    get rows() {
      return rows;
    },
    clear() {
      rows = [];
    },
  };
}
