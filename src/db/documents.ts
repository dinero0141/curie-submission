import type { Queryable } from './pool.js';

export type DocumentFormat = 'markdown' | 'text';
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

/** Document metadata without the (possibly large) content. */
export type DocumentSummary = {
  id: string;
  title: string;
  format: DocumentFormat;
  utf16Length: number;
  status: DocumentStatus;
  failureCode: string | null;
  failureMessage: string | null;
  passageCount: number | null;
  createdAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
};

export type DocumentRow = DocumentSummary & { content: string };

const SUMMARY_COLUMNS = `id, title, format, utf16_length, status, failure_code, failure_message,
  passage_count, created_at, updated_at, ready_at`;

type Raw = Record<string, unknown>;

function toSummary(r: Raw): DocumentSummary {
  return {
    id: r.id as string,
    title: r.title as string,
    format: r.format as DocumentFormat,
    utf16Length: r.utf16_length as number,
    status: r.status as DocumentStatus,
    failureCode: (r.failure_code as string | null) ?? null,
    failureMessage: (r.failure_message as string | null) ?? null,
    passageCount: (r.passage_count as number | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    readyAt: (r.ready_at as Date | null) ?? null,
  };
}

function toRow(r: Raw): DocumentRow {
  return { ...toSummary(r), content: r.content as string };
}

export async function insertDocument(
  q: Queryable,
  doc: { title: string; format: DocumentFormat; content: string },
): Promise<DocumentSummary> {
  const res = await q.query(
    `INSERT INTO documents (title, format, content, utf16_length, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING ${SUMMARY_COLUMNS}`,
    // utf16_length is computed in JS: offsets everywhere are JS string indices.
    [doc.title, doc.format, doc.content, doc.content.length],
  );
  return toSummary(res.rows[0]);
}

export async function getDocument(q: Queryable, id: string): Promise<DocumentRow | null> {
  const res = await q.query(`SELECT ${SUMMARY_COLUMNS}, content FROM documents WHERE id = $1`, [id]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function getDocumentSummary(q: Queryable, id: string): Promise<DocumentSummary | null> {
  const res = await q.query(`SELECT ${SUMMARY_COLUMNS} FROM documents WHERE id = $1`, [id]);
  return res.rows[0] ? toSummary(res.rows[0]) : null;
}

export async function listDocuments(q: Queryable): Promise<DocumentSummary[]> {
  const res = await q.query(`SELECT ${SUMMARY_COLUMNS} FROM documents ORDER BY created_at DESC, id`);
  return res.rows.map(toSummary);
}

/** Move to `processing` unless already terminal. Returns false when the document is ready/failed/missing. */
export async function markDocumentProcessing(q: Queryable, id: string): Promise<boolean> {
  const res = await q.query(
    `UPDATE documents SET status = 'processing', updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'processing')`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Move an in-flight document to `ready`. Returns false when it is already terminal (or missing). */
export async function markDocumentReady(q: Queryable, id: string, passageCount: number): Promise<boolean> {
  const res = await q.query(
    `UPDATE documents
     SET status = 'ready', passage_count = $2, failure_code = NULL, failure_message = NULL,
         ready_at = now(), updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'processing')`,
    [id, passageCount],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Move an in-flight document to `failed`. Returns false when it is already terminal (or missing). */
export async function markDocumentFailed(q: Queryable, id: string, code: string, message: string): Promise<boolean> {
  const res = await q.query(
    `UPDATE documents
     SET status = 'failed', failure_code = $2, failure_message = $3, updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'processing')`,
    [id, code, message],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Lock the document row (`SELECT ... FOR UPDATE`) inside a transaction and return its status,
 * so concurrent preparation runs of the same document serialize their final write.
 */
export async function lockDocumentStatus(q: Queryable, id: string): Promise<DocumentStatus | null> {
  const res = await q.query(`SELECT status FROM documents WHERE id = $1 FOR UPDATE`, [id]);
  return (res.rows[0]?.status as DocumentStatus | undefined) ?? null;
}

/** In-flight documents not touched for `olderThanMs` (reconciler input). */
export async function listStaleInFlightDocuments(q: Queryable, olderThanMs: number): Promise<DocumentSummary[]> {
  const res = await q.query(
    `SELECT ${SUMMARY_COLUMNS} FROM documents
     WHERE status IN ('pending', 'processing')
       AND updated_at < now() - make_interval(secs => $1::double precision / 1000)
     ORDER BY updated_at`,
    [olderThanMs],
  );
  return res.rows.map(toSummary);
}
