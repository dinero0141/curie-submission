/**
 * Reconciler: the safety net for rows that are in flight in Postgres but not progressing in BullMQ.
 *
 * Runs in the worker on start and then every `intervalMs` (60 s). For each in-flight row
 * (`documents.status in (pending, processing)`, assistant `messages.status in (pending, streaming)`)
 * whose `updated_at` is older than `staleAfterMs` (2 min), it looks the job up by id (job id = row id):
 *
 * - no job (the request-path enqueue timed out or failed, or the job was already removed) → enqueue it;
 * - job `failed` → mark the row `failed/stalled` with a fixed message and log the job's last error (the
 *   processor's own failure write did not land, or BullMQ failed the job itself, e.g. it stalled too many times);
 * - job `completed` but the row is still in flight → mark the row `failed/stalled`;
 * - job active / waiting / delayed / prioritized / waiting-children → leave it (BullMQ owns it).
 *
 * Every write is guarded in SQL to in-flight rows, so a processor finishing at the same moment wins or
 * loses cleanly; it can never reopen a terminal row.
 */
import type pg from 'pg';
import type { Logger } from 'pino';
import { listStaleInFlightDocuments, markDocumentFailed } from '../db/documents.js';
import { failAnswer, listStaleInFlightAnswers } from '../db/messages.js';
import { enqueuePrepareDocument, enqueueGenerateAnswer, type Queues } from './queues.js';

export const RECONCILE_INTERVAL_MS = 60_000;
export const STALE_AFTER_MS = 120_000;
/** Error code written on rows the reconciler gives up on. */
export const STALLED = 'stalled';

export type ReconcilerDeps = {
  pool: pg.Pool;
  queues: Pick<Queues, 'prepareDocument' | 'generateAnswer'>;
  /** Rows untouched for longer than this are checked (default `STALE_AFTER_MS`). */
  staleAfterMs?: number;
  /** Interval between runs after `start()` (default `RECONCILE_INTERVAL_MS`). */
  intervalMs?: number;
  log?: Pick<Logger, 'info' | 'warn' | 'error'>;
};

export type ReconcileAction = 'enqueued' | 'failed' | 'left';

export type ReconcileReport = {
  documents: Record<ReconcileAction, string[]>;
  answers: Record<ReconcileAction, string[]>;
};

type JobLookup = {
  getJob(id: string): Promise<{ getState(): Promise<string>; failedReason?: string } | undefined>;
};

/** Stored on a row whose job failed: `failedReason` may be raw internal error text, so it is only logged. */
export const JOB_FAILED_MESSAGE = 'the job failed without recording a final state (see the worker log)';

type Decision =
  | { action: 'enqueue' }
  | { action: 'fail'; message: string; failedReason?: string }
  | { action: 'leave'; state: string };

async function decide(queue: JobLookup, id: string): Promise<Decision> {
  const job = await queue.getJob(id);
  if (!job) return { action: 'enqueue' };
  const state = await job.getState();
  if (state === 'failed') {
    return { action: 'fail', message: JOB_FAILED_MESSAGE, failedReason: job.failedReason || 'unknown error' };
  }
  if (state === 'completed') return { action: 'fail', message: 'job completed but the row was left in flight' };
  // active / waiting / delayed / prioritized / waiting-children: BullMQ still owns it.
  // 'unknown' means the job vanished between the two calls; the next run sees "no job" and enqueues.
  return { action: 'leave', state };
}

const emptyBucket = (): Record<ReconcileAction, string[]> => ({ enqueued: [], failed: [], left: [] });

type Kind = {
  rows: (pool: pg.Pool, olderThanMs: number) => Promise<{ id: string }[]>;
  queue: JobLookup;
  enqueue: (id: string) => Promise<void>;
  fail: (id: string, message: string) => Promise<boolean>;
  /** Log field for the row id. */
  idKey: string;
};

export function createReconciler(deps: ReconcilerDeps) {
  const staleAfterMs = deps.staleAfterMs ?? STALE_AFTER_MS;
  const intervalMs = deps.intervalMs ?? RECONCILE_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<ReconcileReport | null> | null = null;
  let stopped = false;

  const documents: Kind = {
    rows: listStaleInFlightDocuments,
    queue: deps.queues.prepareDocument,
    enqueue: (id) => enqueuePrepareDocument(deps.queues.prepareDocument, id),
    fail: (id, message) => markDocumentFailed(deps.pool, id, STALLED, message),
    idKey: 'documentId',
  };
  const answers: Kind = {
    rows: listStaleInFlightAnswers,
    queue: deps.queues.generateAnswer,
    enqueue: (id) => enqueueGenerateAnswer(deps.queues.generateAnswer, id),
    fail: (id, message) => failAnswer(deps.pool, id, STALLED, message),
    idKey: 'messageId',
  };

  /** Check every stale row of one kind; a failing row is logged and skipped, never aborting the pass. */
  async function reconcile(kind: Kind): Promise<Record<ReconcileAction, string[]>> {
    const bucket = emptyBucket();
    for (const { id } of await kind.rows(deps.pool, staleAfterMs)) {
      try {
        const d = await decide(kind.queue, id);
        if (d.action === 'enqueue') {
          await kind.enqueue(id);
          bucket.enqueued.push(id);
        } else if (d.action === 'fail') {
          if (await kind.fail(id, d.message)) {
            bucket.failed.push(id);
            if (d.failedReason) deps.log?.warn({ [kind.idKey]: id, failedReason: d.failedReason }, 'reconciler: failed row whose job failed');
          }
        } else {
          bucket.left.push(id);
        }
      } catch (err) {
        deps.log?.error({ [kind.idKey]: id, err }, 'reconciler: row check failed');
      }
    }
    return bucket;
  }

  async function reconcileOnce(): Promise<ReconcileReport> {
    const report: ReconcileReport = { documents: await reconcile(documents), answers: await reconcile(answers) };
    const changed = [report.documents, report.answers].some((b) => b.enqueued.length + b.failed.length > 0);
    if (changed) deps.log?.warn({ documents: report.documents, answers: report.answers }, 'reconciler repaired rows');
    return report;
  }

  /** One pass; concurrent calls share the pass in progress. Never rejects (errors are logged → null). */
  function runOnce(): Promise<ReconcileReport | null> {
    running ??= reconcileOnce()
      .catch((err: unknown) => {
        deps.log?.error({ err }, 'reconciler run failed');
        return null;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    runOnce,
    /** Run now, then every `intervalMs` until `stop()`. */
    start(): void {
      if (timer || stopped) return;
      void runOnce();
      timer = setInterval(() => void runOnce(), intervalMs);
      timer.unref();
    },
    /** Stop the timer and wait for a pass in progress. */
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

export type Reconciler = ReturnType<typeof createReconciler>;
