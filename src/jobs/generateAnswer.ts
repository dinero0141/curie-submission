/**
 * generate-answer processor: clear partial content → `streaming` → select passages → model call with
 * throttled partial `content` writes (progressive polling) → `resolveCitations` → one final update.
 *
 * Final-state rule (same as prepare-document): the processor writes the terminal `failed` state itself,
 * immediately for permanent errors (rethrown as `UnrecoverableError`) and on the last attempt for retryable
 * ones. `worker.on('failed')` is only a logging backstop.
 */
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { getConversation } from '../db/conversations.js';
import { getDocument } from '../db/documents.js';
import {
  completeAnswer,
  failAnswer,
  listMessages,
  startAnswer,
  writePartialContent,
  type MessageRow,
} from '../db/messages.js';
import { listPassages } from '../db/passages.js';
import { resolveCitations } from '../domain/citations.js';
import { selectPassages } from '../domain/retrieval.js';
import { classifyError } from '../llm/errors.js';
import { buildRequest } from '../llm/prompt.js';
import type { AnswerModel } from '../llm/types.js';
import { isFinalAttempt } from './prepareDocument.js';
import { QUEUE_NAMES, type GenerateAnswerJobData } from './queues.js';

/** Default interval between partial `content` writes while an answer streams. */
export const PARTIAL_WRITE_INTERVAL_MS = 400;

export type GenerateAnswerDeps = {
  pool: pg.Pool;
  model: AnswerModel;
  fullContextTokens: number;
  /** Throttle for partial content writes (default `PARTIAL_WRITE_INTERVAL_MS`). */
  partialWriteMs?: number;
  log?: Pick<Logger, 'info' | 'warn' | 'error'>;
};

export type GenerateAnswerResult =
  | { outcome: 'completed'; answerable: boolean; citations: number }
  | { outcome: 'skipped'; reason: 'missing' | 'terminal' | 'superseded' };

/** The message's surroundings are inconsistent (no question before it, document gone). Not worth a retry. */
export class AnswerContextError extends Error {
  override readonly name = 'AnswerContextError';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

/**
 * Coalesces streamed text into at most one `content` write per interval. Writes run one at a time, in
 * order; `stop()` cancels the pending write and waits for the one in flight, so the final update always
 * lands after the last partial write. A failed partial write is logged and skipped (the final update is
 * what counts).
 */
class PartialWriter {
  private text = '';
  private written = '';
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly write: (content: string) => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly onError: (err: unknown) => void,
  ) {}

  append(delta: string): void {
    if (this.stopped || delta === '') return;
    this.text += delta;
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  private flush(): void {
    this.timer = undefined;
    const snapshot = this.text;
    this.chain = this.chain.then(async () => {
      if (this.stopped || snapshot === this.written) return;
      try {
        await this.write(snapshot);
        this.written = snapshot;
      } catch (err) {
        this.onError(err);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.chain;
  }
}

type AnswerContext = {
  documentTitle: string;
  content: string;
  question: string;
  history: MessageRow[];
  documentId: string;
};

/** The question is the user message right before the assistant message; history is everything earlier. */
async function loadContext(pool: pg.Pool, msg: MessageRow): Promise<AnswerContext | 'missing'> {
  const conversation = await getConversation(pool, msg.conversationId);
  if (!conversation) return 'missing';
  const doc = await getDocument(pool, conversation.documentId);
  if (!doc) throw new AnswerContextError(`document ${conversation.documentId} not found`);
  if (doc.status !== 'ready') throw new AnswerContextError(`document ${doc.id} is ${doc.status}, not ready`);
  const messages = await listMessages(pool, msg.conversationId);
  const user = messages.find((m) => m.seq === msg.seq - 1);
  if (!user || user.role !== 'user') throw new AnswerContextError(`no question before message ${msg.id}`);
  return {
    documentTitle: doc.title,
    content: doc.content,
    question: user.content,
    history: messages.filter((m) => m.seq < msg.seq),
    documentId: doc.id,
  };
}

export function createGenerateAnswerProcessor(deps: GenerateAnswerDeps) {
  const partialWriteMs = deps.partialWriteMs ?? PARTIAL_WRITE_INTERVAL_MS;

  return async function generateAnswer(
    job: Pick<Job<GenerateAnswerJobData>, 'data' | 'attemptsMade' | 'opts' | 'id'>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<GenerateAnswerResult> {
    const { messageId } = job.data;
    try {
      // Guarded: clears partial content from a stalled run, moves to `streaming`, bumps `attempts`.
      const msg = await startAnswer(deps.pool, messageId);
      if (!msg) return { outcome: 'skipped', reason: 'terminal' };

      const ctx = await loadContext(deps.pool, msg);
      if (ctx === 'missing') return { outcome: 'skipped', reason: 'missing' };

      const passages = await listPassages(deps.pool, ctx.documentId);
      const retrieval = selectPassages(passages, { fullContextTokens: deps.fullContextTokens });
      const request = buildRequest({
        documentTitle: ctx.documentTitle,
        content: ctx.content,
        passages: retrieval.passages,
        history: ctx.history,
        question: ctx.question,
      });

      const writer = new PartialWriter(
        (content) => writePartialContent(deps.pool, messageId, content),
        partialWriteMs,
        (err) => deps.log?.warn({ messageId, err: messageOf(err) }, 'partial content write failed'),
      );
      let raw;
      try {
        raw = await deps.model.generate(request, (delta) => writer.append(delta), signal);
      } finally {
        await writer.stop();
      }

      const resolved = resolveCitations(raw, request.documents, ctx.content);
      const done = await completeAnswer(deps.pool, messageId, {
        content: resolved.text,
        answerable: resolved.answerable,
        citations: resolved.citations,
        retrieval: {
          mode: retrieval.mode,
          passageOrdinals: retrieval.passages.map((p) => p.ordinal),
          tokenEstimate: retrieval.tokenEstimate,
          documentTokens: retrieval.documentTokens,
          debug: {
            notFoundReason: resolved.notFoundReason,
            // The displayed text is the model text when answerable; keep the raw text only when it differs.
            ...(resolved.answerable ? {} : { rawText: resolved.rawText }),
            dropped: resolved.dropped,
          },
        },
        finishReason: raw.stopReason,
        model: raw.model,
        usage: raw.usage,
      });
      if (!done) return { outcome: 'skipped', reason: 'superseded' }; // e.g. the reconciler failed it meanwhile
      return { outcome: 'completed', answerable: resolved.answerable, citations: resolved.citations.length };
    } catch (err) {
      const classified =
        err instanceof AnswerContextError
          ? { code: 'internal_error', retryable: false, message: err.message }
          : classifyError(err);
      const permanent = !classified.retryable;
      if (permanent || isFinalAttempt(job)) {
        try {
          await failAnswer(deps.pool, messageId, classified.code, classified.message);
        } catch (writeErr) {
          // Row stays in flight; the reconciler marks it failed once the job is seen as failed.
          deps.log?.error({ messageId, err: writeErr }, 'could not record answer failure');
        }
      }
      if (permanent) throw new UnrecoverableError(`${classified.code}: ${classified.message}`);
      throw err;
    }
  };
}

export type GenerateAnswerWorkerOptions = {
  prefix?: string;
  concurrency?: number;
};

export function createGenerateAnswerWorker(
  connection: Redis,
  deps: GenerateAnswerDeps,
  opts: GenerateAnswerWorkerOptions = {},
): Worker<GenerateAnswerJobData, GenerateAnswerResult> {
  const processor = createGenerateAnswerProcessor(deps);
  const worker = new Worker<GenerateAnswerJobData, GenerateAnswerResult>(
    QUEUE_NAMES.generateAnswer,
    (job, _token, signal) => processor(job, signal),
    {
      connection,
      concurrency: opts.concurrency ?? 4,
      ...(opts.prefix ? { prefix: opts.prefix } : {}),
    },
  );
  // Logging backstop only: terminal row state was already written by the processor.
  worker.on('failed', (job, err) => {
    deps.log?.warn(
      { messageId: job?.data.messageId, attemptsMade: job?.attemptsMade, err: messageOf(err) },
      'generate-answer attempt failed',
    );
  });
  worker.on('error', (err) => deps.log?.error({ err }, 'generate-answer worker error'));
  return worker;
}
