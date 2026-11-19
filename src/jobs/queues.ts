/**
 * BullMQ queues and Redis connections shared by the API (producer) and the worker (consumer).
 * Job ids are the row ids (`documentId`, `assistantMessageId`), so enqueueing twice is a no-op.
 */
import { Queue, type DefaultJobOptions } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_NAMES = {
  prepareDocument: 'prepare-document',
  generateAnswer: 'generate-answer',
} as const;

export type PrepareDocumentJobData = { documentId: string };
/** `messageId` is the assistant message being answered (also the job id). */
export type GenerateAnswerJobData = { messageId: string };

/** Defaults for prepare-document jobs; the processor's final-state rule reads `attempts` from the job. */
export const PREPARE_DOCUMENT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  // Keep finished jobs for a while so the reconciler can tell "completed/failed" from "never enqueued".
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Defaults for generate-answer jobs (same retry/retention policy; the processor applies the final-state rule). */
export const GENERATE_ANSWER_JOB_OPTIONS: DefaultJobOptions = { ...PREPARE_DOCUMENT_JOB_OPTIONS };

/**
 * ioredis connection for BullMQ. `maxRetriesPerRequest: null` is required for workers' blocking
 * commands and keeps producers retrying through a Redis restart instead of failing the command.
 */
export function createRedisConnection(url: string): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  // Connection errors are retried by ioredis; an unhandled 'error' event would crash the process.
  redis.on('error', () => {});
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
      defaultJobOptions: { ...PREPARE_DOCUMENT_JOB_OPTIONS, ...opts.prepareDocument },
    }),
    generateAnswer: new Queue<GenerateAnswerJobData>(QUEUE_NAMES.generateAnswer, {
      connection,
      ...prefix,
      defaultJobOptions: { ...GENERATE_ANSWER_JOB_OPTIONS, ...opts.generateAnswer },
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
