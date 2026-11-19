/**
 * `GET /messages/:id`: the source of truth for an answer. While `status` is `streaming`, `content` holds the
 * partial text written so far (progressive polling); the final update sets everything at once.
 */
import type { FastifyInstance } from 'fastify';
import { getMessage, type MessageRow } from '../../db/messages.js';
import type { AppDeps } from '../app.js';
import { notFound } from '../errors.js';
import { parseId } from '../validation.js';

/** Public JSON shape of a message. User messages carry only the question fields. */
export function messageJson(m: MessageRow) {
  const base = {
    id: m.id,
    conversationId: m.conversationId,
    seq: m.seq,
    role: m.role,
    status: m.status,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    completedAt: m.completedAt?.toISOString() ?? null,
  };
  if (m.role === 'user') return base;
  return {
    ...base,
    answerable: m.answerable,
    citations: m.citations ?? [],
    finishReason: m.finishReason,
    error: m.errorCode ? { code: m.errorCode, message: m.errorMessage ?? '' } : null,
    model: m.model,
    usage: m.usage,
    attempts: m.attempts,
    retrieval: m.retrieval,
  };
}

export function registerMessageRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { id: string } }>('/messages/:id', async (req) => {
    const msg = await getMessage(deps.pool, parseId(req.params.id, 'message'));
    if (!msg) throw notFound('message');
    return messageJson(msg);
  });
}
