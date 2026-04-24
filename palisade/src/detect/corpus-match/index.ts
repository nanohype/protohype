import type { CorpusReadPort, DetectionLayerPort, EmbeddingPort } from "../../ports/index.js";
import type { LayerVerdict } from "../../types/verdict.js";
import type { NormalizedPrompt } from "../../types/prompt.js";

export interface CorpusMatchLayerConfig {
  readonly threshold: number;
  readonly topK: number;
}

/**
 * Corpus-match layer — last line of defense. Embed the prompt, search the
 * known-attack corpus, block on similarity ≥ threshold. UNCERTAIN is
 * impossible here: the corpus is the source of truth for "we have seen
 * this attack before" — either we matched or we didn't.
 */
export function createCorpusMatchLayer(
  embedding: EmbeddingPort,
  corpus: CorpusReadPort,
  config: CorpusMatchLayerConfig,
): DetectionLayerPort {
  return {
    name: "corpus-match" as const,
    async detect(prompt: NormalizedPrompt): Promise<LayerVerdict> {
      const start = Date.now();
      const vec = await embedding.embed(prompt.text);
      const matches = await corpus.search(vec, config.topK);
      const top = matches[0];
      const topScore = top?.similarity ?? 0;
      const outcome: LayerVerdict["outcome"] = topScore >= config.threshold ? "MALICIOUS" : "BENIGN";
      return {
        layer: "corpus-match",
        outcome,
        score: topScore,
        detail: {
          topK: matches.length,
          ...(top ? { topCorpusId: top.corpusId, topTaxonomy: top.taxonomy } : {}),
        },
        latencyMs: Date.now() - start,
      };
    },
  };
}
