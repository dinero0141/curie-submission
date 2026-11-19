/** Integration tests always use the dedicated `curie_test` database, never the dev one. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL?.trim() || 'postgres://curie:curie@localhost:54329/curie_test';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL?.trim() || 'redis://localhost:63799';
