/**
 * prepare-document processor: `pending|processing` → chunk → one transaction (replace passages, `ready`).
 *
 * Final-state rule: the processor itself writes the terminal `failed` state — immediately for permanent
 * errors (`ChunkingError`: `empty_after_parse`, `too_many_passages`, rethrown as `UnrecoverableError`
 * so BullMQ does not retry), and on the last attempt for anything else (`preparation_error`).
 * `worker.on('failed')` is only a logging backstop.
 */
import { UnrecoverableError, type Job, type Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import {
  getDocument,
  getDocumentSummary,
  lockDocumentStatus,
  markDocumentFailed,
  markDocumentProcessing,
  markDocumentReady,
} from '../db/documents.js';
import { replacePassages } from '../db/passages.js';
import { withTx } from '../db/pool.js';
import { ChunkingError, chunkDocument, type Passage } from '../domain/chunking.js';
import { createWorker, isFinalAttempt, QUEUE_NAMES, type PrepareDocumentJobData, type WorkerOptions } from './queues.js';

/**
 * Upper bound on passages per document. A 5 MB document of ~400-token passages is ~3,300 passages;
 * this only trips on pathological input (e.g. a heading every few words), which fails permanently.
 */
export const MAX_PASSAGES = 20_000;

/** Stored for `preparation_error`: the original text (SQL, constraint names) is only logged. */
export const PREPARATION_ERROR_MESSAGE = 'internal error while preparing the document';

export type PrepareDocumentDeps = {
  pool: pg.Pool;
  passageTokens: number;
  maxPassages?: number;
  /** Injectable for tests (transient failures, races); defaults to `chunkDocument`. May be async. */
  chunk?: (...args: Parameters<typeof chunkDocument>) => Passage[] | Promise<Passage[]>;
  log?: Pick<Logger, 'info' | 'warn' | 'error'>;
};

export type PrepareDocumentResult =
  | { outcome: 'ready'; passageCount: number }
  | { outcome: 'skipped'; reason: 'missing' | 'terminal' };

export function createPrepareDocumentProcessor(deps: PrepareDocumentDeps) {
  const chunk = deps.chunk ?? chunkDocument;
  const maxPassages = deps.maxPassages ?? MAX_PASSAGES;

  return async function prepareDocument(
    job: Pick<Job<PrepareDocumentJobData>, 'data' | 'attemptsMade' | 'opts' | 'id'>,
  ): Promise<PrepareDocumentResult> {
    const { documentId } = job.data;
    try {
      // Guarded transition: a stale rerun of a ready/failed document does nothing.
      if (!(await markDocumentProcessing(deps.pool, documentId))) {
        const exists = (await getDocumentSummary(deps.pool, documentId)) !== null;
        return { outcome: 'skipped', reason: exists ? 'terminal' : 'missing' };
      }
      const doc = await getDocument(deps.pool, documentId);
      if (!doc) return { outcome: 'skipped', reason: 'missing' };

      const passages = await chunk(doc.content, doc.format, { passageTokens: deps.passageTokens, maxPassages });

      return await withTx(deps.pool, async (tx) => {
        // Serialize with any concurrent run (or reconciler write) on the same row.
        const status = await lockDocumentStatus(tx, documentId);
        if (status !== 'pending' && status !== 'processing') {
          return { outcome: 'skipped', reason: status === null ? 'missing' : 'terminal' } as const;
        }
        await replacePassages(tx, documentId, passages); // delete + insert: reruns are idempotent
        await markDocumentReady(tx, documentId, passages.length);
        return { outcome: 'ready', passageCount: passages.length } as const;
      });
    } catch (err) {
      const permanent = err instanceof ChunkingError;
      if (!permanent) deps.log?.error({ documentId, attemptsMade: job.attemptsMade, err }, 'error while preparing a document');
      if (permanent || isFinalAttempt(job)) {
        const code = permanent ? err.code : 'preparation_error';
        const message = permanent ? err.message : PREPARATION_ERROR_MESSAGE;
        try {
          await markDocumentFailed(deps.pool, documentId, code, message);
        } catch (writeErr) {
          // Row stays in flight; the reconciler marks it failed once the job is seen as failed.
          deps.log?.error({ documentId, err: writeErr }, 'could not record document failure');
        }
      }
      if (permanent) throw new UnrecoverableError(`${err.code}: ${err.message}`);
      throw err;
    }
  };
}

export function createPrepareDocumentWorker(
  connection: Redis,
  deps: PrepareDocumentDeps,
  opts: WorkerOptions = {},
): Worker<PrepareDocumentJobData, PrepareDocumentResult> {
  const processor = createPrepareDocumentProcessor(deps);
  return createWorker<PrepareDocumentJobData, PrepareDocumentResult>({
    name: QUEUE_NAMES.prepareDocument,
    processor: (job) => processor(job),
    idKey: 'documentId',
    connection,
    log: deps.log,
    concurrency: opts.concurrency ?? 2,
    prefix: opts.prefix,
  });
}
