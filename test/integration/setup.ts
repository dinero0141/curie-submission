/**
 * Per-file integration harness. Call `useIntegrationEnv()` at the top of a test file:
 * - `beforeAll`: open a pool on `curie_test` and TRUNCATE all tables (schema is migrated once by globalSetup);
 * - a unique BullMQ `prefix` so queues from different files never see each other's jobs;
 * - `afterAll`: delete this file's Redis keys and close connections.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './urls.js';

export { TEST_DATABASE_URL, TEST_REDIS_URL };

export type IntegrationEnv = {
  /** Pool on `curie_test`; valid inside tests and hooks registered after `useIntegrationEnv()`. */
  readonly pool: pg.Pool;
  /** BullMQ key prefix unique to this test file. */
  readonly bullPrefix: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
};

export async function truncateAll(q: Pick<pg.Pool, 'query'>): Promise<void> {
  await q.query('TRUNCATE documents, passages, conversations, messages CASCADE');
}

export function useIntegrationEnv(): IntegrationEnv {
  const file = basename(expect.getState().testPath ?? 'unknown', '.test.ts');
  const bullPrefix = `curie-test:${file}:${randomUUID().slice(0, 8)}`;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL, { connectionTimeoutMillis: 3_000 });
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool?.end();
    pool = undefined;
    await deleteRedisKeys(`${bullPrefix}:*`);
  });

  return {
    get pool(): pg.Pool {
      if (!pool) throw new Error('integration pool used outside of tests/hooks');
      return pool;
    },
    bullPrefix,
    databaseUrl: TEST_DATABASE_URL,
    redisUrl: TEST_REDIS_URL,
  };
}

async function deleteRedisKeys(pattern: string): Promise<void> {
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3_000, retryStrategy: () => null });
  redis.on('error', () => {});
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}
