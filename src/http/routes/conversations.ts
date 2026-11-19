/**
 * Conversation routes. Asking a question stores the user message (`completed`) and an assistant message
 * (`pending`) in one transaction, enqueues `generate-answer` (job id = assistant message id) and answers 202;
 * the model never runs in the request. One answer at a time per conversation is enforced by the
 * `one_inflight_answer` partial unique index (→ 409 `answer_in_progress`).
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getConversation, insertConversation, lockConversation, touchConversation } from '../../db/conversations.js';
import { getDocumentSummary } from '../../db/documents.js';
import { insertMessage, listMessages, ONE_INFLIGHT_ANSWER } from '../../db/messages.js';
import { isUniqueViolation, withTx, type Queryable } from '../../db/pool.js';
import { enqueueGenerateAnswer, settlesWithin } from '../../jobs/queues.js';
import type { AppDeps } from '../app.js';
import { HttpError, notFound } from '../errors.js';
import { invalidRequest, parseId } from './documents.js';
import { messageJson } from './messages.js';

export const MAX_QUESTION_LENGTH = 2000;

const Question = z
  .string({ error: 'question must be a string' })
  .trim()
  .min(1, 'question must not be empty')
  .max(MAX_QUESTION_LENGTH, `question must be at most ${MAX_QUESTION_LENGTH} characters`);

const CreateConversationBody = z.object({
  documentId: z.string({ error: 'documentId must be a string' }),
  question: Question,
});

const AskBody = z.object({ question: Question });

export type AskResult = { conversationId: string; userMessageId: string; assistantMessageId: string };

/** Insert the question and a pending answer. The caller holds the conversation row lock in `tx`. */
async function insertTurn(tx: Queryable, conversationId: string, question: string): Promise<AskResult> {
  const user = await insertMessage(tx, { conversationId, role: 'user', content: question });
  let assistant;
  try {
    assistant = await insertMessage(tx, { conversationId, role: 'assistant' });
  } catch (err) {
    if (isUniqueViolation(err, ONE_INFLIGHT_ANSWER)) {
      throw new HttpError(409, 'answer_in_progress', 'wait for the current answer to finish before asking again');
    }
    throw err;
  }
  await touchConversation(tx, conversationId);
  return { conversationId, userMessageId: user.id, assistantMessageId: assistant.id };
}

async function enqueue(deps: AppDeps, log: FastifyBaseLogger, messageId: string): Promise<void> {
  const enqueued = await settlesWithin(
    enqueueGenerateAnswer(deps.queues.generateAnswer, messageId),
    deps.enqueueTimeoutMs ?? 2_000,
  );
  if (!enqueued.ok) {
    // The pending row is the source of truth; the reconciler enqueues stale pending answers.
    log.warn({ messageId, err: enqueued.error }, 'generate-answer enqueue deferred to reconciler');
  }
}

export function registerConversationRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/conversations', async (req, reply) => {
    const parsed = CreateConversationBody.safeParse(req.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    const { documentId, question } = parsed.data;

    const doc = await getDocumentSummary(deps.pool, parseId(documentId, 'document'));
    if (!doc) throw notFound('document');
    if (doc.status !== 'ready') {
      const detail = doc.status === 'failed' ? `failed (${doc.failureCode ?? 'unknown'})` : doc.status;
      throw new HttpError(409, 'document_not_ready', `document is ${detail}; wait until its status is ready`);
    }

    // `ready` is terminal, so the check above cannot go stale before the insert.
    const result = await withTx(deps.pool, async (tx) => {
      const conversation = await insertConversation(tx, doc.id);
      await lockConversation(tx, conversation.id);
      return insertTurn(tx, conversation.id, question);
    });
    await enqueue(deps, req.log, result.assistantMessageId);
    return reply.code(202).send(result);
  });

  app.post<{ Params: { id: string } }>('/conversations/:id/messages', async (req, reply) => {
    const id = parseId(req.params.id, 'conversation');
    const parsed = AskBody.safeParse(req.body);
    if (!parsed.success) throw invalidRequest(parsed.error);

    const result = await withTx(deps.pool, async (tx) => {
      // Serializes seq allocation with any concurrent question on this conversation.
      if (!(await lockConversation(tx, id))) throw notFound('conversation');
      return insertTurn(tx, id, parsed.data.question);
    });
    await enqueue(deps, req.log, result.assistantMessageId);
    return reply.code(202).send(result);
  });

  app.get<{ Params: { id: string } }>('/conversations/:id', async (req) => {
    const conversation = await getConversation(deps.pool, parseId(req.params.id, 'conversation'));
    if (!conversation) throw notFound('conversation');
    const messages = await listMessages(deps.pool, conversation.id);
    return {
      id: conversation.id,
      documentId: conversation.documentId,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages: messages.map(messageJson),
    };
  });
}
