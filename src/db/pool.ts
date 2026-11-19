import pg from 'pg';
import type { Logger } from 'pino';

/** Anything that can run a query: the pool itself or a checked-out client inside a transaction. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export type PoolOptions = {
  /** Fail fast instead of hanging when Postgres is unreachable. */
  connectionTimeoutMillis?: number;
  max?: number;
  /** Where idle-client errors are reported (they never crash the process). */
  log?: Pick<Logger, 'warn'>;
};

export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
    max: opts.max ?? 10,
  });
  // An idle client erroring (e.g. Postgres restart) must not crash the process; the pool replaces it.
  pool.on('error', (err) => opts.log?.warn({ err: err.message }, 'idle postgres client error'));
  return pool;
}

/** Run `fn` inside BEGIN/COMMIT on one client; ROLLBACK and rethrow on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** True when `err` is a Postgres unique violation (23505), optionally of a specific constraint/index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
