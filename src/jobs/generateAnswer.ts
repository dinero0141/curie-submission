/**
 * generate-answer processor: clear partial content → `streaming` → select passages → model call with
 * throttled partial `content` writes (progressive polling) → `resolveCitations` → one final update.
 *
 * Final-state rule (same as prepare-document): the processor writes the terminal `failed` state itself,
 * immediately for permanent errors (`model_config_error`, `context_too_large`, `model_refused`; rethrown as
 * `UnrecoverableError`) and on the last attempt for retryable ones (`model_unavailable`). A retryable failure
 * before the last attempt puts the row back to `pending` for BullMQ's backoff. `max_tokens` with at least one
 * verified citation completes with `finish_reason = 'max_tokens'`; without one it fails permanently with
 * `answer_truncated` (it is not evidence that the document lacks the answer). A reply with no verified
 * citation and no `NOT_IN_DOCUMENT:` marker (uncited, or every citation dropped by verification) fails
 * permanently with `citations_unverified` and a warn log of the drop reasons: it is not evidence either, and
 * it is how a wrong Citations shape assumption would show up. `worker.on('failed')` is only a logging backstop.
 */
import { UnrecoverableError, type Job, type Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { getConversation } from '../db/conversations.js';
import { getDocument } from '../db/documents.js';
import {
  completeAnswer,
  failAnswer,
  listMessages,
  requeueAnswer,
  startAnswer,
  writePartialContent,
  type MessageRow,
} from '../db/messages.js';
import { getPassagesByOrdinals, listPassages, type PassageRow } from '../db/passages.js';
import { listPassageIndex, searchPassages, type SearchOutcome } from '../db/search.js';
import { resolveCitations } from '../domain/citations.js';
import {
  RANKED_TOP_K,
  fitsFullContext,
  retrievalQueryText,
  selectPassages,
  type RetrievalResult,
} from '../domain/retrieval.js';
import { classifyError, type ClassifiedError } from '../llm/errors.js';
import { buildRequest } from '../llm/prompt.js';
import type { AnswerModel } from '../llm/types.js';
import { PartialWriter } from './partialWriter.js';
import { createWorker, isFinalAttempt, QUEUE_NAMES, type GenerateAnswerJobData, type WorkerOptions } from './queues.js';

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

/** The reply hit `max_tokens` before any citation survived verification. Permanent: a retry has the same budget. */
export class AnswerTruncatedError extends Error {
  override readonly name = 'AnswerTruncatedError';
  constructor() {
    super('the answer reached the max_tokens limit before it cited the document');
  }
}

/**
 * The model answered without the not-found marker but no citation survived verification (it cited nothing, or
 * every citation was dropped). Permanent: a shape mismatch repeats on every attempt.
 */
export class AnswerUnverifiedError extends Error {
  override readonly name = 'AnswerUnverifiedError';
  constructor(dropped: number) {
    super(
      dropped > 0
        ? `the answer's ${dropped} citation(s) could not be verified against the document`
        : 'the answer did not cite the document, so it could not be verified',
    );
  }
}

/** Stored for `internal_error`: the original text (SQL, constraint names, stack details) is only logged. */
export const INTERNAL_ERROR_MESSAGE = 'internal error while generating the answer';

type AnswerOutcomeError = { code: 'answer_truncated' | 'citations_unverified'; retryable: false; message: string };

function classify(err: unknown): ClassifiedError | AnswerOutcomeError {
  if (err instanceof AnswerTruncatedError) return { code: 'answer_truncated', retryable: false, message: err.message };
  if (err instanceof AnswerUnverifiedError) return { code: 'citations_unverified', retryable: false, message: err.message };
  if (err instanceof AnswerContextError) return { code: 'internal_error', retryable: false, message: INTERNAL_ERROR_MESSAGE };
  const classified = classifyError(err);
  return classified.code === 'internal_error' ? { ...classified, message: INTERNAL_ERROR_MESSAGE } : classified;
}

function shapeOf(c: unknown): { type: unknown; keys: string[] } | string {
  if (c === null) return 'null';
  if (typeof c !== 'object' || Array.isArray(c)) return Array.isArray(c) ? 'array' : typeof c;
  return { type: (c as Record<string, unknown>).type, keys: Object.keys(c).sort() };
}

type AnswerContext = {
  documentTitle: string;
  content: string;
  question: string;
  /** The user question before `question` in this conversation, if any (for the retrieval query). */
  previousQuestion: string | null;
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
  const previous = messages.filter((m) => m.role === 'user' && m.seq < user.seq).at(-1);
  return {
    documentTitle: doc.title,
    content: doc.content,
    question: user.content,
    previousQuestion: previous?.content ?? null,
    history: messages.filter((m) => m.seq < msg.seq),
    documentId: doc.id,
  };
}

/**
 * Pick the passages for this answer. A document within `fullContextTokens` is sent whole (no search);
 * a larger one is searched with the current + previous question (`ranked`, or `fallback` without hits).
 * Only the selected passages' text is loaded for a large document.
 */
async function retrieve(
  pool: pg.Pool,
  ctx: AnswerContext,
  fullContextTokens: number,
): Promise<{ retrieval: RetrievalResult<PassageRow>; search: (SearchOutcome & { text: string }) | null }> {
  const opts = { fullContextTokens };
  const index = await listPassageIndex(pool, ctx.documentId);
  if (fitsFullContext(index, opts)) {
    return { retrieval: selectPassages(await listPassages(pool, ctx.documentId), opts), search: null };
  }
  const text = retrievalQueryText(ctx.question, ctx.previousQuestion);
  const search = await searchPassages(pool, ctx.documentId, text, RANKED_TOP_K);
  const chosen = selectPassages(index, opts, search.hits);
  // A ready document's passages never change (they are replaced only while pending/processing).
  const rows = await getPassagesByOrdinals(pool, ctx.documentId, chosen.passages.map((p) => p.ordinal));
  return { retrieval: { ...chosen, passages: rows }, search: { ...search, text } };
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

      const { retrieval, search } = await retrieve(deps.pool, ctx, deps.fullContextTokens);
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
        (err) => deps.log?.warn({ messageId, err }, 'partial content write failed'),
      );
      let raw;
      try {
        raw = await deps.model.generate(request, (delta) => writer.append(delta), signal);
      } finally {
        await writer.stop();
      }

      // The model saw only part of a large document: "not found" must not read as "the document lacks it".
      const resolved = resolveCitations(raw, request.documents, ctx.content, { partial: retrieval.mode !== 'full' });
      if (resolved.notFoundReason === 'truncated') throw new AnswerTruncatedError();
      if (resolved.notFoundReason === 'unverified') {
        // Visible in the worker log: a Citations shape mismatch drops every citation with the same reason.
        deps.log?.warn(
          {
            messageId,
            stopReason: raw.stopReason,
            // Reason plus the citation's type and keys (no document text) is enough to spot a shape mismatch.
            dropped: resolved.dropped.map((d) => ({ reason: d.reason, answerBlock: d.answerBlock, shape: shapeOf(d.citation) })),
          },
          'answer has no verified citation; failing as citations_unverified',
        );
        throw new AnswerUnverifiedError(resolved.dropped.length);
      }
      const done = await completeAnswer(deps.pool, messageId, {
        content: resolved.text,
        answerable: resolved.answerable,
        citations: resolved.citations,
        retrieval: {
          mode: retrieval.mode,
          passageIds: retrieval.passages.map((p) => p.id),
          passageOrdinals: retrieval.passages.map((p) => p.ordinal),
          hits: retrieval.hits,
          tokenEstimate: retrieval.tokenEstimate,
          documentTokens: retrieval.documentTokens,
          debug: {
            query: search ? { text: search.text, tsquery: search.tsquery } : null,
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
      const classified = classify(err);
      if (classified.code === 'internal_error') deps.log?.error({ messageId, err }, 'internal error while generating an answer');
      const permanent = !classified.retryable;
      if (permanent || isFinalAttempt(job)) {
        try {
          await failAnswer(deps.pool, messageId, classified.code, classified.message);
        } catch (writeErr) {
          // Row stays in flight; the reconciler marks it failed once the job is seen as failed.
          deps.log?.error({ messageId, err: writeErr }, 'could not record answer failure');
        }
      } else {
        // BullMQ retries after a backoff; meanwhile show `pending` without the failed attempt's partial text.
        await requeueAnswer(deps.pool, messageId).catch((writeErr: unknown) =>
          deps.log?.warn({ messageId, err: writeErr }, 'could not reset answer for retry'),
        );
        deps.log?.warn({ messageId, attemptsMade: job.attemptsMade, code: classified.code }, 'answer attempt failed; will retry');
      }
      if (permanent) throw new UnrecoverableError(`${classified.code}: ${classified.message}`);
      throw err;
    }
  };
}

export function createGenerateAnswerWorker(
  connection: Redis,
  deps: GenerateAnswerDeps,
  opts: WorkerOptions = {},
): Worker<GenerateAnswerJobData, GenerateAnswerResult> {
  const processor = createGenerateAnswerProcessor(deps);
  return createWorker<GenerateAnswerJobData, GenerateAnswerResult>({
    name: QUEUE_NAMES.generateAnswer,
    processor: (job, _token, signal) => processor(job, signal),
    idKey: 'messageId',
    connection,
    log: deps.log,
    concurrency: opts.concurrency ?? 4,
    prefix: opts.prefix,
  });
}
