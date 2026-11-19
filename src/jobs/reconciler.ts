/**
 * Reconciler: the safety net for rows that are in flight in Postgres but not progressing in BullMQ.
 *
 * Runs in the worker on start and then every `intervalMs` (60 s). For each in-flight row
 * (`documents.status in (pending, processing)`, assistant `messages.status in (pending, streaming)`)
 * whose `updated_at` is older than `staleAfterMs` (2 min), it looks the job up by id (job id = row id):
 *
 * - no job (the request-path enqueue timed out or failed, or the job was already removed) → enqueue it;
 * - job `failed` → mark the row `failed/stalled` with the job's last error (the processor's own failure
 *   write did not land, or BullMQ failed the job itself, e.g. it stalled too many times);
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

type Decision = { action: 'enqueue' } | { action: 'fail'; message: string } | { action: 'leave'; state: string };

async function decide(queue: JobLookup, id: string): Promise<Decision> {
  const job = await queue.getJob(id);
  if (!job) return { action: 'enqueue' };
  const state = await job.getState();
  if (state === 'failed') {
    return { action: 'fail', message: `job failed without a terminal row update: ${job.failedReason || 'unknown error'}` };
  }
  if (state === 'completed') return { action: 'fail', message: 'job completed but the row was left in flight' };
  // active / waiting / delayed / prioritized / waiting-children: BullMQ still owns it.
  // 'unknown' means the job vanished between the two calls; the next run sees "no job" and enqueues.
  return { action: 'leave', state };
}

const emptyBucket = (): Record<ReconcileAction, string[]> => ({ enqueued: [], failed: [], left: [] });

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

export function createReconciler(deps: ReconcilerDeps) {
  const staleAfterMs = deps.staleAfterMs ?? STALE_AFTER_MS;
  const intervalMs = deps.intervalMs ?? RECONCILE_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<ReconcileReport | null> | null = null;
  let stopped = false;

  async function reconcileOnce(): Promise<ReconcileReport> {
    const report: ReconcileReport = { documents: emptyBucket(), answers: emptyBucket() };

    for (const doc of await listStaleInFlightDocuments(deps.pool, staleAfterMs)) {
      try {
        const d = await decide(deps.queues.prepareDocument, doc.id);
        if (d.action === 'enqueue') {
          await enqueuePrepareDocument(deps.queues.prepareDocument, doc.id);
          report.documents.enqueued.push(doc.id);
        } else if (d.action === 'fail') {
          if (await markDocumentFailed(deps.pool, doc.id, STALLED, d.message)) report.documents.failed.push(doc.id);
        } else {
          report.documents.left.push(doc.id);
        }
      } catch (err) {
        deps.log?.error({ documentId: doc.id, err: messageOf(err) }, 'reconciler: document check failed');
      }
    }

    for (const msg of await listStaleInFlightAnswers(deps.pool, staleAfterMs)) {
      try {
        const d = await decide(deps.queues.generateAnswer, msg.id);
        if (d.action === 'enqueue') {
          await enqueueGenerateAnswer(deps.queues.generateAnswer, msg.id);
          report.answers.enqueued.push(msg.id);
        } else if (d.action === 'fail') {
          if (await failAnswer(deps.pool, msg.id, STALLED, d.message)) report.answers.failed.push(msg.id);
        } else {
          report.answers.left.push(msg.id);
        }
      } catch (err) {
        deps.log?.error({ messageId: msg.id, err: messageOf(err) }, 'reconciler: answer check failed');
      }
    }

    const changed = [report.documents, report.answers].some((b) => b.enqueued.length + b.failed.length > 0);
    if (changed) deps.log?.warn({ documents: report.documents, answers: report.answers }, 'reconciler repaired rows');
    return report;
  }

  /** One pass; concurrent calls share the pass in progress. Never rejects (errors are logged → null). */
  function runOnce(): Promise<ReconcileReport | null> {
    running ??= reconcileOnce()
      .catch((err: unknown) => {
        deps.log?.error({ err: messageOf(err) }, 'reconciler run failed');
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
