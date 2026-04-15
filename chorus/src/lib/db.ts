import pg from 'pg';
const { Pool } = pg;
let _pool: pg.Pool | undefined;
export function getDbPool(): pg.Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL required');
    _pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'chorus',
    });
    _pool.on('error', (err) =>
      console.error(
        JSON.stringify({ level: 'error', message: 'pg pool error', error: String(err) }),
      ),
    );
  }
  return _pool;
}
export async function closeDbPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}
