/**
 * Passage selection for one answer. Pure, no I/O (the search itself is `src/db/search.ts`).
 *
 * - `full`: the whole document fits `FULL_CONTEXT_TOKENS` → every passage, in document order.
 * - `ranked`: the document is larger and the lexical search found hits → the top `RANKED_TOP_K` hits plus
 *   their ±1 neighbours, capped at the same token budget, in document order.
 * - `fallback`: larger document but no usable hits (e.g. a stopword-only question) → leading passages up to
 *   the budget.
 * Every mode sends at least one passage when the document has any.
 */

/** Minimal passage shape (a `PassageRow` or a `PassageIndexRow` fits). */
export type RetrievablePassage = { id: string; ordinal: number; tokenEstimate: number };

export type RetrievalMode = 'full' | 'ranked' | 'fallback';

/** How many search hits ranked mode considers. */
export const RANKED_TOP_K = 8;

/** One search result, best first (as `searchPassages` returns them). */
export type RankedHit = { ordinal: number; score: number };

/** A search hit as recorded on the answer. `rank` is 1-based; a hit cut by the budget is still listed. */
export type RetrievalHit = { passageId: string; ordinal: number; rank: number; score: number };

export type RetrievalResult<P extends RetrievablePassage> = {
  mode: RetrievalMode;
  /** Passages to send, in document order. Never empty when the document has passages. */
  passages: P[];
  /** Sum of `tokenEstimate` over the selected passages. */
  tokenEstimate: number;
  /** Sum of `tokenEstimate` over the whole document. */
  documentTokens: number;
  /** Search hits that refer to a passage of this document, best first; `[]` unless `ranked`. */
  hits: RetrievalHit[];
};

export type RetrievalOptions = {
  /** `FULL_CONTEXT_TOKENS`: send the whole document when it is at most this many (estimated) tokens. Also the
   * budget for `ranked` and `fallback` selections. */
  fullContextTokens: number;
};

/**
 * Text searched for in ranked mode: the current question plus the previous user question, so a follow-up
 * such as "And keyword search?" still carries the earlier question's terms.
 */
export function retrievalQueryText(question: string, previousQuestion?: string | null): string {
  return [question, previousQuestion ?? '']
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('\n');
}

function sumTokens(passages: readonly RetrievablePassage[]): number {
  return passages.reduce((n, p) => n + p.tokenEstimate, 0);
}

/** True when the whole document goes to the model (`full`), so no search is needed. */
export function fitsFullContext(passages: readonly RetrievablePassage[], opts: RetrievalOptions): boolean {
  return sumTokens(passages) <= opts.fullContextTokens;
}

export function selectPassages<P extends RetrievablePassage>(
  passages: readonly P[],
  opts: RetrievalOptions,
  hits?: readonly RankedHit[] | null,
): RetrievalResult<P> {
  const ordered = [...passages].sort((a, b) => a.ordinal - b.ordinal);
  const documentTokens = sumTokens(ordered);
  const budget = opts.fullContextTokens;
  if (documentTokens <= budget) {
    return { mode: 'full', passages: ordered, tokenEstimate: documentTokens, documentTokens, hits: [] };
  }

  const ranked = rankedSelection(ordered, budget, hits ?? []);
  if (ranked) return { mode: 'ranked', ...ranked, documentTokens };

  // Leading passages within the budget; always at least one so the request is never empty.
  const selected: P[] = [];
  let tokens = 0;
  for (const p of ordered) {
    if (selected.length > 0 && tokens + p.tokenEstimate > budget) break;
    selected.push(p);
    tokens += p.tokenEstimate;
  }
  return { mode: 'fallback', passages: selected, tokenEstimate: tokens, documentTokens, hits: [] };
}

/**
 * Budget-capped hits + neighbours. Hits are added first, in rank order (the first one even if it alone
 * exceeds the budget), then the ±1 neighbours of the hits that made it in, again in rank order. A passage
 * that does not fit is skipped and later smaller ones may still be added. Returns null when no hit refers
 * to a known passage.
 */
function rankedSelection<P extends RetrievablePassage>(
  ordered: readonly P[],
  budget: number,
  hits: readonly RankedHit[],
): { passages: P[]; tokenEstimate: number; hits: RetrievalHit[] } | null {
  const byOrdinal = new Map(ordered.map((p) => [p.ordinal, p]));
  const recorded: RetrievalHit[] = [];
  const seenHits = new Set<number>();
  hits.slice(0, RANKED_TOP_K).forEach((h, i) => {
    const p = byOrdinal.get(h.ordinal);
    if (!p || seenHits.has(h.ordinal)) return;
    seenHits.add(h.ordinal);
    recorded.push({ passageId: p.id, ordinal: p.ordinal, rank: i + 1, score: h.score });
  });
  if (recorded.length === 0) return null;

  const selected = new Set<number>();
  let tokens = 0;
  const tryAdd = (ordinal: number): boolean => {
    const p = byOrdinal.get(ordinal);
    if (!p || selected.has(ordinal)) return false;
    if (selected.size > 0 && tokens + p.tokenEstimate > budget) return false;
    selected.add(ordinal);
    tokens += p.tokenEstimate;
    return true;
  };

  const included = recorded.filter((h) => tryAdd(h.ordinal));
  for (const h of included) {
    tryAdd(h.ordinal - 1);
    tryAdd(h.ordinal + 1);
  }

  return {
    passages: ordered.filter((p) => selected.has(p.ordinal)),
    tokenEstimate: tokens,
    hits: recorded,
  };
}
