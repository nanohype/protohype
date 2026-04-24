import type { Pool } from "pg";
import type { ApprovedSample, CorpusMatch } from "../types/corpus.js";
import type { CorpusReadPort, CorpusWritePort } from "../ports/index.js";

export interface PgvectorCorpusDeps {
  readonly pool: Pool;
  readonly table?: string;
}

/**
 * pgvector-backed corpus. Read and write share a connection pool but live
 * in separate returned objects — the gate can hold the writer, everything
 * else holds only the reader. The invariant "only the gate writes" is
 * enforced by the grep-gate CI rule, not by runtime identity.
 *
 * Schema (via migrations — see infra/ + docs/runbook.md):
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   CREATE TABLE attack_corpus (
 *     corpus_id TEXT PRIMARY KEY,
 *     body_sha256 TEXT NOT NULL UNIQUE,
 *     prompt_text TEXT NOT NULL,
 *     embedding vector(1024) NOT NULL,
 *     taxonomy TEXT NOT NULL,
 *     label TEXT NOT NULL,
 *     approved_by TEXT NOT NULL,
 *     approved_at TIMESTAMPTZ NOT NULL,
 *     source_attempt_id TEXT NOT NULL
 *   );
 *   CREATE INDEX ON attack_corpus USING ivfflat (embedding vector_cosine_ops);
 */
export function createPgvectorCorpus(deps: PgvectorCorpusDeps): { read: CorpusReadPort; write: CorpusWritePort } {
  const table = deps.table ?? "attack_corpus";

  const read: CorpusReadPort = {
    async search(embedding, topK): Promise<CorpusMatch[]> {
      const vectorLiteral = `[${Array.from(embedding).join(",")}]`;
      const { rows } = await deps.pool.query<{
        corpus_id: string;
        taxonomy: string;
        label: string;
        similarity: number;
      }>(
        `SELECT corpus_id, taxonomy, label, 1 - (embedding <=> $1::vector) AS similarity
         FROM ${table}
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [vectorLiteral, topK],
      );
      return rows.map((r) => ({
        corpusId: r.corpus_id,
        taxonomy: r.taxonomy as CorpusMatch["taxonomy"],
        label: r.label,
        similarity: Number(r.similarity),
      }));
    },
  };

  // IMPORTANT: addAttack is the grep-gated operation — only the label-approval
  // gate may hold a reference to this object.
  const write: CorpusWritePort = {
    async addAttack(sample: ApprovedSample): Promise<void> {
      const vectorLiteral = `[${Array.from(sample.embedding).join(",")}]`;
      await deps.pool.query(
        `INSERT INTO ${table} (corpus_id, body_sha256, prompt_text, embedding, taxonomy, label, approved_by, approved_at, source_attempt_id)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9)
         ON CONFLICT (body_sha256) DO NOTHING`,
        [
          sample.corpusId,
          sample.bodySha256,
          sample.promptText,
          vectorLiteral,
          sample.taxonomy,
          sample.label,
          sample.approvedBy,
          sample.approvedAt,
          sample.sourceAttemptId,
        ],
      );
    },
  };

  return { read, write };
}
