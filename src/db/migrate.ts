import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';
import { createPool } from './pool.js';

/** `migrations/` at the repo root; resolves the same from `src/db` (tsx) and `dist/db` (build). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Arbitrary constant key so concurrent migrators (compose service, test runs) serialize. */
const MIGRATION_LOCK_KEY = 4_270_001;

/**
 * Apply every `*.sql` file in lexical order. Files are idempotent (IF NOT EXISTS), so this simply
 * re-executes them all; there is no migrations table to drift. Returns the file names applied.
 */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      for (const file of files) {
        const sql = await readFile(join(dir, file), 'utf8');
        await client.query(sql);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return files;
}

const DEFAULT_DATABASE_URL = 'postgres://curie:curie@localhost:54329/curie';

async function main(): Promise<void> {
  // Only DATABASE_URL is needed here; full config validation (API key etc.) is not.
  const url = process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
  const pool = createPool(url);
  try {
    const files = await migrate(pool);
    console.log(`migrations applied: ${files.join(', ') || '(none)'}`);
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error('migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
