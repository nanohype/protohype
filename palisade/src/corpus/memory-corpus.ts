import type { ApprovedSample, CorpusMatch } from "../types/corpus.js";
import type { CorpusReadPort, CorpusWritePort } from "../ports/index.js";

/**
 * In-process corpus for tests + dev. Naive linear scan with cosine similarity.
 * Not intended for production — pgvector is the production adapter.
 */
export function createMemoryCorpus(): { read: CorpusReadPort; write: CorpusWritePort; seed(s: ApprovedSample): void; size(): number } {
  const items: ApprovedSample[] = [];

  function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      dot += av * bv;
      magA += av * av;
      magB += bv * bv;
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  const read: CorpusReadPort = {
    async search(embedding, topK): Promise<CorpusMatch[]> {
      return items
        .map((s) => ({
          corpusId: s.corpusId,
          taxonomy: s.taxonomy,
          label: s.label,
          similarity: cosine(embedding, s.embedding),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK);
    },
  };

  const write: CorpusWritePort = {
    async addAttack(sample: ApprovedSample): Promise<void> {
      if (items.some((i) => i.bodySha256 === sample.bodySha256)) return;
      items.push(sample);
    },
  };

  return { read, write, seed: (s) => items.push(s), size: () => items.length };
}
