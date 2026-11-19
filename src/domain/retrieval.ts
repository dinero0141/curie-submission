/**
 * Passage selection for one answer. Pure, no I/O.
 *
 * Implemented now: `full` (the whole document fits the context budget → every passage, in order) and
 * `fallback` (leading passages up to the budget). Ranked lexical retrieval for documents over the budget
 * comes with Task 11 and will replace `fallback` as the large-document path.
 */

/** Minimal passage shape (a `PassageRow` fits). */
export type RetrievablePassage = { id: string; ordinal: number; tokenEstimate: number };

export type RetrievalMode = 'full' | 'ranked' | 'fallback';

export type RetrievalResult<P extends RetrievablePassage> = {
  mode: RetrievalMode;
  /** Passages to send, in document order. Never empty when the document has passages. */
  passages: P[];
  /** Sum of `tokenEstimate` over the selected passages. */
  tokenEstimate: number;
  /** Sum of `tokenEstimate` over the whole document. */
  documentTokens: number;
};

export type RetrievalOptions = {
  /** `FULL_CONTEXT_TOKENS`: send the whole document when it is at most this many (estimated) tokens. */
  fullContextTokens: number;
};

export function selectPassages<P extends RetrievablePassage>(
  passages: readonly P[],
  opts: RetrievalOptions,
): RetrievalResult<P> {
  const ordered = [...passages].sort((a, b) => a.ordinal - b.ordinal);
  const documentTokens = ordered.reduce((n, p) => n + p.tokenEstimate, 0);
  if (documentTokens <= opts.fullContextTokens) {
    return { mode: 'full', passages: ordered, tokenEstimate: documentTokens, documentTokens };
  }
  // Leading passages within the budget; always at least one so the request is never empty.
  const selected: P[] = [];
  let tokens = 0;
  for (const p of ordered) {
    if (selected.length > 0 && tokens + p.tokenEstimate > opts.fullContextTokens) break;
    selected.push(p);
    tokens += p.tokenEstimate;
  }
  return { mode: 'fallback', passages: selected, tokenEstimate: tokens, documentTokens };
}
