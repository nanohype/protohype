#!/usr/bin/env tsx
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';
const { Client } = pg;
async function migrate() {
  const cs = process.env.DATABASE_URL;
  if (!cs) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }
  const client = new Client({ connectionString: cs });
  await client.connect();
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
  );
  const dir = path.join(process.cwd(), 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const version = file.replace('.sql', '');
    const { rows } = await client.query('SELECT version FROM schema_migrations WHERE version=$1', [
      version,
    ]);
    if (rows.length) {
      console.log(`⏭  ${version}`);
      continue;
    }
    console.log(`▶  ${version}...`);
    await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    console.log(`✅ ${version}`);
  }
  await client.end();
}
migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
