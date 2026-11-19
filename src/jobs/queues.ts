/**
 * BullMQ queues and Redis connections shared by the API (producer) and the worker (consumer).
 * Job ids are the row ids (`documentId`, `assistantMessageId`), so enqueueing twice is a no-op.
 */
import { Queue, Worker, type DefaultJobOptions, type Job, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

export const QUEUE_NAMES = {
  prepareDocument: 'prepare-document',
  generateAnswer: 'generate-answer',
} as const;

export type PrepareDocumentJobData = { documentId: string };
/** `messageId` is the assistant message being answered (also the job id). */
export type GenerateAnswerJobData = { messageId: string };

/** Defaults for both queues; the processors' final-state rule reads `attempts` from the job. */
export const JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  // Keep finished jobs for a while so the reconciler can tell "completed/failed" from "never enqueued".
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** True when this run is the job's last allowed attempt (`attemptsMade` counts finished attempts). */
export function isFinalAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/** Request-path wait for an enqueue before deferring it to the reconciler (`enqueueOrDefer`). */
export const ENQUEUE_TIMEOUT_MS = 2_000;

/** Error text only, for the deliberately terse Redis outage log (other logs pass the Error itself). */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

/**
 * ioredis connection for BullMQ. `maxRetriesPerRequest: null` is required for workers' blocking
 * commands and keeps producers retrying through a Redis restart instead of failing the command.
 * Connection errors are retried by ioredis (an unhandled 'error' event would crash the process); the
 * first error of each outage is logged, and the reconnect after it.
 */
export function createRedisConnection(url: string, log?: Pick<Logger, 'warn' | 'info'>): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  let down = false;
  redis.on('error', (err: unknown) => {
    if (down) return;
    down = true;
    log?.warn({ err: messageOf(err) }, 'redis connection error; retrying');
  });
  redis.on('ready', () => {
    if (down) log?.info('redis connection restored');
    down = false;
  });
  return redis;
}

export type QueueOptions = {
  /** BullMQ key prefix (tests use a unique one per file). */
  prefix?: string;
  /** Overrides merged over the defaults (tests shorten backoff). */
  prepareDocument?: Partial<DefaultJobOptions>;
  generateAnswer?: Partial<DefaultJobOptions>;
};

export type Queues = {
  prepareDocument: Queue<PrepareDocumentJobData>;
  generateAnswer: Queue<GenerateAnswerJobData>;
};

export function createQueues(connection: Redis, opts: QueueOptions = {}): Queues {
  const prefix = opts.prefix ? { prefix: opts.prefix } : {};
  return {
    prepareDocument: new Queue<PrepareDocumentJobData>(QUEUE_NAMES.prepareDocument, {
      connection,
      ...prefix,
      defaultJobOptions: { ...JOB_OPTIONS, ...opts.prepareDocument },
    }),
    generateAnswer: new Queue<GenerateAnswerJobData>(QUEUE_NAMES.generateAnswer, {
      connection,
      ...prefix,
      defaultJobOptions: { ...JOB_OPTIONS, ...opts.generateAnswer },
    }),
  };
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all(Object.values(queues).map((q) => q.close()));
}

export async function enqueuePrepareDocument(queue: Queues['prepareDocument'], documentId: string): Promise<void> {
  await queue.add('prepare', { documentId }, { jobId: documentId });
}

export async function enqueueGenerateAnswer(queue: Queues['generateAnswer'], messageId: string): Promise<void> {
  await queue.add('answer', { messageId }, { jobId: messageId });
}

export type Settled = { ok: true } | { ok: false; error: unknown };

/**
 * Await `promise` for at most `ms`; never rejects (a late rejection is swallowed, not unhandled).
 * Used on the request path: the database row is the source of truth, so a slow or failed enqueue is
 * logged and left to the reconciler instead of failing (or hanging) the request.
 */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<Settled> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: new Error(`timed out after ${ms} ms`) }), ms);
  });
  const settled = promise.then(
    (): Settled => ({ ok: true }),
    (error: unknown): Settled => ({ ok: false, error }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Request-path enqueue: wait at most `ms`. On a timeout or failure log a warning and return; the row is
 * already written and is the source of truth, and the reconciler enqueues stale in-flight rows later.
 */
export async function enqueueOrDefer(
  enqueue: Promise<unknown>,
  ms: number,
  log: Pick<Logger, 'warn'>,
  context: Record<string, unknown>,
  what: string,
): Promise<void> {
  const enqueued = await settlesWithin(enqueue, ms);
  if (!enqueued.ok) log.warn({ ...context, err: enqueued.error }, `${what} enqueue deferred to reconciler`);
}

export type WorkerOptions = {
  /** BullMQ key prefix (tests use a unique one per file). */
  prefix?: string;
  concurrency?: number;
};

/**
 * A BullMQ worker with the shared logging backstop. Terminal row state is written by the processor itself,
 * so `failed` only logs the attempt (with the row id under `idKey`) and `error` logs worker-level errors.
 */
export function createWorker<D extends object, R>(spec: {
  name: string;
  processor: Processor<D, R>;
  idKey: keyof D & string;
  connection: Redis;
  log: Pick<Logger, 'warn' | 'error'> | undefined;
  concurrency: number;
  prefix: string | undefined;
}): Worker<D, R> {
  const { name, idKey, log } = spec;
  const worker = new Worker<D, R>(name, spec.processor, {
    connection: spec.connection,
    concurrency: spec.concurrency,
    ...(spec.prefix ? { prefix: spec.prefix } : {}),
  });
  worker.on('failed', (job, err) => {
    log?.warn({ [idKey]: job?.data[idKey], attemptsMade: job?.attemptsMade, err }, `${name} attempt failed`);
  });
  worker.on('error', (err) => log?.error({ err }, `${name} worker error`));
  return worker;
}
