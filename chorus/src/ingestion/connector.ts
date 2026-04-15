import type { Pool } from 'pg';
import type { RawFeedbackItem, SourceType } from './types.js';

/**
 * Connector contract: a stateless poller that, given the last cursor it
 * stored, returns the next batch of RawFeedbackItems and the new cursor
 * value. Cursor persistence happens via {@link readCursor}/{@link writeCursor}
 * against the `ingestion_cursors` table — connectors never touch the DB
 * themselves.
 */
export interface Connector {
  readonly source: SourceType;
  poll(opts: { cursorValue: string | null }): Promise<PollResult>;
}

export interface PollResult {
  items: RawFeedbackItem[];
  /** New cursor to persist; null leaves the cursor unchanged. */
  nextCursor: string | null;
}

export async function readCursor(db: Pool, source: SourceType): Promise<string | null> {
  const { rows } = await db.query<{ cursor_value: string | null }>(
    'SELECT cursor_value FROM ingestion_cursors WHERE source = $1',
    [source],
  );
  return rows[0]?.cursor_value ?? null;
}

export async function writeCursor(
  db: Pool,
  source: SourceType,
  cursorValue: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO ingestion_cursors (source, cursor_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (source) DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()`,
    [source, cursorValue],
  );
}
