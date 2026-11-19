/** Worker entrypoint: BullMQ processors (prepare-document; generate-answer and the reconciler come later). */
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createPrepareDocumentWorker } from './jobs/prepareDocument.js';
import { createRedisConnection } from './jobs/queues.js';
import { loadEnvFile } from './loadEnv.js';

// First statement: the modules above only read the environment when called.
loadEnvFile();

const log = pino({ name: 'worker', level: process.env.LOG_LEVEL ?? 'info' });
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const redis = createRedisConnection(config.redisUrl);

const workers = [createPrepareDocumentWorker(redis, { pool, passageTokens: config.passageTokens, log })];
log.info({ queues: workers.map((w) => w.name) }, 'worker started');

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info({ signal }, 'shutting down');
  try {
    // close() waits for active jobs; their processors still write terminal state.
    await Promise.all(workers.map((w) => w.close()));
    await redis.quit();
    await pool.end();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
