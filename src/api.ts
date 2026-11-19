/** API entrypoint: Fastify + queue producers. Long work is only enqueued here, never run. */
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp } from './http/app.js';
import { closeQueues, createQueues, createRedisConnection } from './jobs/queues.js';
import { loadEnvFile } from './loadEnv.js';
import { onShutdown } from './shutdown.js';

// First statement: the modules above only read the environment when called.
loadEnvFile();

const config = loadConfig();
const level = config.logLevel;
// Connection-level errors (Redis outage, idle Postgres client) are logged here, not per request.
const infraLog = pino({ name: 'api', level });
const pool = createPool(config.databaseUrl, { log: infraLog });
const redis = createRedisConnection(config.redisUrl, infraLog);
const queues = createQueues(redis);
const app = buildApp({ pool, config, queues, logger: { level } });

onShutdown(app.log, async () => {
  await app.close();
  await closeQueues(queues);
  await redis.quit();
  await pool.end();
});

await app.listen({ host: '0.0.0.0', port: config.port });
