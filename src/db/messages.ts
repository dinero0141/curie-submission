import type { Queryable } from './pool.js';

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'failed';

export type MessageRow = {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  answerable: boolean | null;
  citations: unknown;
  retrieval: unknown;
  finishReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  model: string | null;
  usage: unknown;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

/** Name of the partial unique index allowing one in-flight assistant answer per conversation. */
export const ONE_INFLIGHT_ANSWER = 'one_inflight_answer';

const COLUMNS = `id, conversation_id, seq, role, content, status, answerable, citations, retrieval,
  finish_reason, error_code, error_message, model, usage, attempts, created_at, updated_at, completed_at`;

function toRow(r: Record<string, unknown>): MessageRow {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    seq: r.seq as number,
    role: r.role as MessageRole,
    content: r.content as string,
    status: r.status as MessageStatus,
    answerable: (r.answerable as boolean | null) ?? null,
    citations: r.citations ?? null,
    retrieval: r.retrieval ?? null,
    finishReason: (r.finish_reason as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    usage: r.usage ?? null,
    attempts: r.attempts as number,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    completedAt: (r.completed_at as Date | null) ?? null,
  };
}

/**
 * Insert a message with the next `seq` in its conversation. The caller must hold the conversation
 * row lock (`lockConversation`) in the same transaction, otherwise concurrent inserts can collide.
 * User messages are inserted `completed`; assistant messages `pending`.
 * Throws a 23505 on `one_inflight_answer` when an assistant answer is already in flight.
 */
export async function insertMessage(
  q: Queryable,
  msg: { conversationId: string; role: MessageRole; content?: string },
): Promise<MessageRow> {
  const status: MessageStatus = msg.role === 'user' ? 'completed' : 'pending';
  const res = await q.query(
    `INSERT INTO messages (conversation_id, seq, role, content, status, completed_at)
     SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, CASE WHEN $4 = 'completed' THEN now() END
     FROM messages WHERE conversation_id = $1
     RETURNING ${COLUMNS}`,
    [msg.conversationId, msg.role, msg.content ?? '', status],
  );
  return toRow(res.rows[0]);
}

export async function getMessage(q: Queryable, id: string): Promise<MessageRow | null> {
  const res = await q.query(`SELECT ${COLUMNS} FROM messages WHERE id = $1`, [id]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function listMessages(q: Queryable, conversationId: string): Promise<MessageRow[]> {
  const res = await q.query(`SELECT ${COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY seq`, [
    conversationId,
  ]);
  return res.rows.map(toRow);
}

/**
 * Begin a processing run: clear any partial content from a previous (stalled) run, move to
 * `streaming`, bump `attempts`. `attempts` counts processing runs, not BullMQ attempts: a stalled-job rerun
 * or a reconciler re-enqueue adds a run, so it can exceed the job's 3 attempts. Returns null when the
 * message is missing or already terminal.
 */
export async function startAnswer(q: Queryable, id: string): Promise<MessageRow | null> {
  const res = await q.query(
    `UPDATE messages
     SET status = 'streaming', content = '', attempts = attempts + 1,
         error_code = NULL, error_message = NULL, updated_at = now()
     WHERE id = $1 AND role = 'assistant' AND status IN ('pending', 'streaming')
     RETURNING ${COLUMNS}`,
    [id],
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

/** Progressive delivery: overwrite partial content while the answer is still streaming. */
export async function writePartialContent(q: Queryable, id: string, content: string): Promise<boolean> {
  const res = await q.query(
    `UPDATE messages SET content = $2, updated_at = now() WHERE id = $1 AND status = 'streaming'`,
    [id, content],
  );
  return (res.rowCount ?? 0) > 0;
}

export type CompletedAnswer = {
  content: string;
  answerable: boolean;
  citations: unknown;
  retrieval: unknown;
  finishReason: string | null;
  model: string | null;
  usage: unknown;
};

/** Single final update of a successful answer. */
export async function completeAnswer(q: Queryable, id: string, a: CompletedAnswer): Promise<boolean> {
  const res = await q.query(
    `UPDATE messages
     SET status = 'completed', content = $2, answerable = $3, citations = $4::jsonb, retrieval = $5::jsonb,
         finish_reason = $6, model = $7, usage = $8::jsonb, error_code = NULL, error_message = NULL,
         completed_at = now(), updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'streaming')`,
    [
      id,
      a.content,
      a.answerable,
      JSON.stringify(a.citations ?? null),
      JSON.stringify(a.retrieval ?? null),
      a.finishReason,
      a.model,
      JSON.stringify(a.usage ?? null),
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Terminal failure; frees the conversation for the next question. Partial content is cleared: it is
 * unverified model text and must not read as an answer.
 */
export async function failAnswer(q: Queryable, id: string, code: string, message: string): Promise<boolean> {
  const res = await q.query(
    `UPDATE messages
     SET status = 'failed', content = '', error_code = $2, error_message = $3, updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'streaming')`,
    [id, code, message],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * A retryable attempt failed and BullMQ will retry: back to `pending` with partial content cleared, so a
 * polling client sees "waiting" rather than stale text. Only from `streaming`; returns false otherwise.
 */
export async function requeueAnswer(q: Queryable, id: string): Promise<boolean> {
  const res = await q.query(
    `UPDATE messages SET status = 'pending', content = '', updated_at = now()
     WHERE id = $1 AND status = 'streaming'`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

/** In-flight assistant messages not touched for `olderThanMs` (reconciler input). */
export async function listStaleInFlightAnswers(q: Queryable, olderThanMs: number): Promise<MessageRow[]> {
  const res = await q.query(
    `SELECT ${COLUMNS} FROM messages
     WHERE role = 'assistant' AND status IN ('pending', 'streaming')
       AND updated_at < now() - make_interval(secs => $1::double precision / 1000)
     ORDER BY updated_at`,
    [olderThanMs],
  );
  return res.rows.map(toRow);
}
