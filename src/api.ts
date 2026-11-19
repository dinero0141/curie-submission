/** API entrypoint: Fastify + queue producers. Long work is only enqueued here, never run. */
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp } from './http/app.js';
import { closeQueues, createQueues, createRedisConnection } from './jobs/queues.js';
import { loadEnvFile } from './loadEnv.js';

// First statement: the modules above only read the environment when called.
loadEnvFile();

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const redis = createRedisConnection(config.redisUrl);
const queues = createQueues(redis);
const app = buildApp({ pool, config, queues, logger: { level: process.env.LOG_LEVEL ?? 'info' } });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closeQueues(queues);
    await redis.quit();
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
