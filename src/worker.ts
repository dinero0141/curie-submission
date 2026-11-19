/** Worker entrypoint: BullMQ processors (prepare-document, generate-answer) and the reconciler. */
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createGenerateAnswerWorker } from './jobs/generateAnswer.js';
import { createPrepareDocumentWorker } from './jobs/prepareDocument.js';
import { closeQueues, createQueues, createRedisConnection } from './jobs/queues.js';
import { createReconciler } from './jobs/reconciler.js';
import { createAnswerModel } from './llm/index.js';
import { loadEnvFile } from './loadEnv.js';

// First statement: the modules above only read the environment when called.
loadEnvFile();

const log = pino({ name: 'worker', level: process.env.LOG_LEVEL ?? 'info' });
const config = loadConfig();
const pool = createPool(config.databaseUrl, { log });
const redis = createRedisConnection(config.redisUrl, log);

const model = createAnswerModel(config);

const workers = [
  createPrepareDocumentWorker(redis, { pool, passageTokens: config.passageTokens, log }),
  createGenerateAnswerWorker(redis, { pool, model, fullContextTokens: config.fullContextTokens, log }),
];
// Producer side for the reconciler (re-enqueues rows whose job is missing).
const queues = createQueues(redis);
const reconciler = createReconciler({ pool, queues, log });
reconciler.start(); // runs now, then every 60 s

const provider = config.modelProvider;
log.info(
  { queues: workers.map((w) => w.name), modelProvider: provider, ...(provider === 'anthropic' ? { model: config.anthropicModel } : {}) },
  'worker started',
);
if (provider === 'fake') log.warn('MODEL_PROVIDER=fake: answers come from the scripted demo model, not Claude');

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info({ signal }, 'shutting down');
  try {
    await reconciler.stop();
    // close() waits for active jobs (one answer can take up to MODEL_TIMEOUT_MS); their processors still
    // write terminal state. compose's stop_grace_period is set above that timeout.
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues(queues);
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
