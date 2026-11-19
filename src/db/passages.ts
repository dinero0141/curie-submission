import type { Passage, Span } from '../domain/chunking.js';
import type { Queryable } from './pool.js';

/** A stored passage: what chunking produces (the domain `Passage`) plus its row id. */
export type PassageRow = Passage & { id: string; documentId: string };

const COLUMNS = `id, document_id, ordinal, start_offset, end_offset, heading, sentences, text, token_estimate`;

function toPassageRow(r: Record<string, unknown>): PassageRow {
  return {
    id: r.id as string,
    documentId: r.document_id as string,
    ordinal: r.ordinal as number,
    start: r.start_offset as number,
    end: r.end_offset as number,
    heading: (r.heading as string | null) ?? null,
    sentences: r.sentences as Span[],
    text: r.text as string,
    tokenEstimate: r.token_estimate as number,
  };
}

/** Rows inserted per statement; keeps parameter count well under Postgres' 65535 limit. */
const INSERT_BATCH = 500;

/**
 * Replace all passages of a document (delete + insert), so a re-run of preparation is idempotent.
 * Call inside a transaction.
 */
export async function replacePassages(q: Queryable, documentId: string, passages: Passage[]): Promise<void> {
  await q.query('DELETE FROM passages WHERE document_id = $1', [documentId]);
  for (let i = 0; i < passages.length; i += INSERT_BATCH) {
    const batch = passages.slice(i, i + INSERT_BATCH);
    const values: unknown[] = [];
    const tuples = batch.map((p, j) => {
      const b = j * 8;
      values.push(documentId, p.ordinal, p.start, p.end, p.heading, JSON.stringify(p.sentences), p.text, p.tokenEstimate);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb, $${b + 7}, $${b + 8})`;
    });
    await q.query(
      `INSERT INTO passages (document_id, ordinal, start_offset, end_offset, heading, sentences, text, token_estimate)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}

/** All passages of a document in document order. */
export async function listPassages(q: Queryable, documentId: string): Promise<PassageRow[]> {
  const res = await q.query(`SELECT ${COLUMNS} FROM passages WHERE document_id = $1 ORDER BY ordinal`, [documentId]);
  return res.rows.map(toPassageRow);
}

/** Specific passages by ordinal, in document order. */
export async function getPassagesByOrdinals(
  q: Queryable,
  documentId: string,
  ordinals: number[],
): Promise<PassageRow[]> {
  if (ordinals.length === 0) return [];
  const res = await q.query(
    `SELECT ${COLUMNS} FROM passages WHERE document_id = $1 AND ordinal = ANY($2::int[]) ORDER BY ordinal`,
    [documentId, ordinals],
  );
  return res.rows.map(toPassageRow);
}
