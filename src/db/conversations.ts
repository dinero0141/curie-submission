import type { Queryable } from './pool.js';

export type ConversationRow = {
  id: string;
  documentId: string;
  createdAt: Date;
  updatedAt: Date;
};

const COLUMNS = 'id, document_id, created_at, updated_at';

function toRow(r: Record<string, unknown>): ConversationRow {
  return {
    id: r.id as string,
    documentId: r.document_id as string,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

export async function insertConversation(q: Queryable, documentId: string): Promise<ConversationRow> {
  const res = await q.query(`INSERT INTO conversations (document_id) VALUES ($1) RETURNING ${COLUMNS}`, [documentId]);
  return toRow(res.rows[0]);
}

export async function getConversation(q: Queryable, id: string): Promise<ConversationRow | null> {
  const res = await q.query(`SELECT ${COLUMNS} FROM conversations WHERE id = $1`, [id]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

/**
 * `SELECT ... FOR UPDATE` on the conversation row: serializes seq allocation for its messages.
 * Must run inside a transaction; the lock is held until COMMIT/ROLLBACK.
 */
export async function lockConversation(q: Queryable, id: string): Promise<ConversationRow | null> {
  const res = await q.query(`SELECT ${COLUMNS} FROM conversations WHERE id = $1 FOR UPDATE`, [id]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function touchConversation(q: Queryable, id: string): Promise<void> {
  await q.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [id]);
}
