import type { Pool } from "pg";
import type { VectorStorePort } from "./types.js";

// ── pgvector corpus adapter ────────────────────────────────────────
//
// Schema (created once via the migrate() helper on app startup — see
// src/index.ts wiring):
//
//   CREATE EXTENSION IF NOT EXISTS vector;
//   CREATE TABLE rule_chunks (
//     id            text PRIMARY KEY,
//     source_id     text NOT NULL,
//     rule_change_id text NOT NULL,
//     chunk_index   int  NOT NULL,
//     content       text NOT NULL,
//     embedding     vector(1024) NOT NULL,
//     metadata      jsonb NOT NULL,
//     UNIQUE (source_id, rule_change_id, chunk_index)
//   );
//   CREATE INDEX rule_chunks_src_rc ON rule_chunks (source_id, rule_change_id);
//   CREATE INDEX rule_chunks_embedding_cos ON rule_chunks
//     USING hnsw (embedding vector_cosine_ops);
//

export interface PgVectorStoreDeps {
  readonly pool: Pick<Pool, "query">;
  readonly tableName?: string;
}

const DEFAULT_TABLE = "rule_chunks";

function vectorLiteral(v: readonly number[]): string {
  // pgvector accepts the `'[1,2,3]'::vector` text form. No SQL injection
  // vector here — values are numbers, cast server-side.
  return `[${v.join(",")}]`;
}

export function createPgVectorStore(deps: PgVectorStoreDeps): VectorStorePort {
  const table = deps.tableName ?? DEFAULT_TABLE;
  const pool = deps.pool;

  return {
    async upsert(rows) {
      if (rows.length === 0) return;
      for (const row of rows) {
        await pool.query(
          `INSERT INTO ${table} (id, source_id, rule_change_id, chunk_index, content, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             embedding = EXCLUDED.embedding,
             metadata = EXCLUDED.metadata`,
          [
            row.id,
            row.sourceId,
            row.ruleChangeId,
            row.chunkIndex,
            row.content,
            vectorLiteral(row.embedding),
            JSON.stringify(row.metadata),
          ],
        );
      }
    },
    async deleteByRuleChange(sourceId, ruleChangeId) {
      await pool.query(`DELETE FROM ${table} WHERE source_id = $1 AND rule_change_id = $2`, [
        sourceId,
        ruleChangeId,
      ]);
    },
    async countByRuleChange(sourceId, ruleChangeId) {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE source_id = $1 AND rule_change_id = $2`,
        [sourceId, ruleChangeId],
      );
      const firstRow = result.rows[0] as { n: number } | undefined;
      return firstRow?.n ?? 0;
    },
  };
}

// ── pgvector schema migration ──────────────────────────────────────
export async function ensureCorpusSchema(
  pool: Pick<Pool, "query">,
  opts: { tableName?: string; embeddingDimensions?: number } = {},
): Promise<void> {
  const table = opts.tableName ?? DEFAULT_TABLE;
  const dims = opts.embeddingDimensions ?? 1024;
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${table} (
       id             text PRIMARY KEY,
       source_id      text NOT NULL,
       rule_change_id text NOT NULL,
       chunk_index    int  NOT NULL,
       content        text NOT NULL,
       embedding      vector(${dims}) NOT NULL,
       metadata       jsonb NOT NULL,
       UNIQUE (source_id, rule_change_id, chunk_index)
     )`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${table}_src_rc ON ${table} (source_id, rule_change_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${table}_embedding_cos ON ${table} USING hnsw (embedding vector_cosine_ops)`,
  );
}
