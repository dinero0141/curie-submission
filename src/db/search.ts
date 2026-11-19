/**
 * Lexical passage search (Postgres full-text search over the stored `passages.tsv`, built with the
 * `english` config: stemmed, stopwords removed).
 *
 * The question is turned into an OR query in two passes:
 *   q := to_tsquery('simple', replace(plainto_tsquery('english', $text)::text, ' & ', ' | '))
 * 1. `plainto_tsquery('english', …)` parses free text safely (no tsquery syntax from the user), drops
 *    stopwords and stems once, giving `'hybrid' & 'prototyp'`.
 * 2. `' & '` → `' | '` makes it an OR query: a question rarely shares every term with the right passage.
 * 3. Re-parsing with `simple` keeps the already-stemmed lexemes as they are. Re-parsing with `english` would
 *    stem them a second time and miss (`universities` → `univers` → `univ`). `simple` turns a hyphenated
 *    lexeme such as `'state-of-the-art'` back into a phrase that includes the stopwords; that branch cannot
 *    match an `english` tsvector, but the parts (`'state' | 'art'`) are separate OR branches and do.
 * `numnode(q) = 0` (stopword-only or empty question) means there is nothing to search for: the caller falls
 * back to leading passages. Hits are ranked by `ts_rank_cd` (cover density), ties by document order.
 */
import type { RankedHit } from '../domain/retrieval.js';
import type { Queryable } from './pool.js';

/** Light passage listing for retrieval decisions (no text). */
export type PassageIndexRow = { id: string; ordinal: number; tokenEstimate: number };

export type PassageHit = RankedHit & { id: string };

export type SearchOutcome = {
  /** The OR tsquery as text (`''` when it has no lexemes). */
  tsquery: string;
  /** `numnode(q)`; 0 → nothing to search for. */
  nodes: number;
  /** Best first, at most `limit`. */
  hits: PassageHit[];
};

/** Every passage's id, ordinal and token estimate, in document order. */
export async function listPassageIndex(q: Queryable, documentId: string): Promise<PassageIndexRow[]> {
  const res = await q.query(
    'SELECT id, ordinal, token_estimate FROM passages WHERE document_id = $1 ORDER BY ordinal',
    [documentId],
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    ordinal: r.ordinal as number,
    tokenEstimate: r.token_estimate as number,
  }));
}

/** The OR tsquery for `text` (see module comment) and its node count. */
export async function buildOrQuery(q: Queryable, text: string): Promise<{ tsquery: string; nodes: number }> {
  const res = await q.query(
    `WITH x AS (SELECT to_tsquery('simple', replace(plainto_tsquery('english', $1)::text, ' & ', ' | ')) AS q)
     SELECT q::text AS tsquery, numnode(q) AS nodes FROM x`,
    [text],
  );
  const row = res.rows[0] as { tsquery: string; nodes: number };
  return { tsquery: row.tsquery, nodes: row.nodes };
}

export async function searchPassages(
  q: Queryable,
  documentId: string,
  text: string,
  limit: number,
): Promise<SearchOutcome> {
  const { tsquery, nodes } = await buildOrQuery(q, text);
  if (nodes === 0) return { tsquery, nodes, hits: [] };
  // `$2::tsquery` is the query built above, passed back as text: the cast parses tsquery syntax without
  // any text-search config, so the lexemes are used exactly as built.
  const res = await q.query(
    `SELECT id, ordinal, ts_rank_cd(tsv, $2::tsquery) AS score
       FROM passages
      WHERE document_id = $1 AND tsv @@ $2::tsquery
      ORDER BY score DESC, ordinal
      LIMIT $3`,
    [documentId, tsquery, limit],
  );
  return {
    tsquery,
    nodes,
    hits: res.rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      ordinal: r.ordinal as number,
      score: Number(r.score),
    })),
  };
}
