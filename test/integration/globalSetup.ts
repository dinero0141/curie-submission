/**
 * Runs once per `vitest run` for the integration project: fail fast with a clear message when the
 * compose services are down (instead of hanging on connection retries), then migrate `curie_test`.
 */
import { Redis } from 'ioredis';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './urls.js';

const HINT = 'Start the services with `docker compose up -d postgres redis` (see README).';

async function checkPostgresAndMigrate(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL, { connectionTimeoutMillis: 3_000, max: 1 });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(
      `Integration tests: Postgres unreachable at ${redact(TEST_DATABASE_URL)} (${describe(err)}). ${HINT}`,
    );
  }
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

async function checkRedis(): Promise<void> {
  const redis = new Redis(TEST_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null, // no reconnect loop: one attempt, then fail
  });
  redis.on('error', () => {});
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(`Integration tests: Redis unreachable at ${TEST_REDIS_URL} (${describe(err)}). ${HINT}`);
  } finally {
    redis.disconnect();
  }
}

function describe(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) return describe(err.errors[0]);
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function redact(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}

export default async function setup(): Promise<void> {
  await Promise.all([checkPostgresAndMigrate(), checkRedis()]);
}
