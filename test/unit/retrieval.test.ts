import { describe, expect, it } from 'vitest';
import {
  RANKED_TOP_K,
  fitsFullContext,
  retrievalQueryText,
  selectPassages,
  type RankedHit,
} from '../../src/domain/retrieval.js';

const passages = (tokens: number[]) => tokens.map((t, i) => ({ id: `p${i}`, ordinal: i, tokenEstimate: t }));
const hits = (...ordinals: number[]): RankedHit[] => ordinals.map((ordinal, i) => ({ ordinal, score: 1 - i / 100 }));
const ordinalsOf = (r: { passages: { ordinal: number }[] }) => r.passages.map((p) => p.ordinal);

describe('retrievalQueryText', () => {
  it('combines the current question with the previous user question', () => {
    expect(retrievalQueryText('And keyword search?', 'How many questions did the hybrid prototype get right?')).toBe(
      'And keyword search?\nHow many questions did the hybrid prototype get right?',
    );
  });

  it('uses the current question alone on the first turn', () => {
    expect(retrievalQueryText('Who owned the pilot?')).toBe('Who owned the pilot?');
    expect(retrievalQueryText('Who owned the pilot?', null)).toBe('Who owned the pilot?');
  });

  it('trims both parts and skips a blank previous question', () => {
    expect(retrievalQueryText('  Who?  ', '   ')).toBe('Who?');
    expect(retrievalQueryText(' a ', ' b ')).toBe('a\nb');
  });
});

describe('mode selection by token total', () => {
  it('fitsFullContext compares the summed estimate with the budget (inclusive)', () => {
    expect(fitsFullContext(passages([30, 30]), { fullContextTokens: 60 })).toBe(true);
    expect(fitsFullContext(passages([30, 31]), { fullContextTokens: 60 })).toBe(false);
    expect(fitsFullContext([], { fullContextTokens: 0 })).toBe(true);
  });

  it('sends the whole document in order when it fits, ignoring any hits', () => {
    const r = selectPassages([...passages([10, 20, 30])].reverse(), { fullContextTokens: 60 }, hits(2));
    expect(r.mode).toBe('full');
    expect(ordinalsOf(r)).toEqual([0, 1, 2]);
    expect(r).toMatchObject({ tokenEstimate: 60, documentTokens: 60, hits: [] });
  });

  it('uses ranked mode one token over the budget when there are hits', () => {
    const r = selectPassages(passages([10, 20, 31]), { fullContextTokens: 60 }, hits(1));
    expect(r.mode).toBe('ranked');
    expect(r.documentTokens).toBe(61);
  });

  it('falls back to leading passages within the budget when there are no hits', () => {
    for (const none of [undefined, null, []]) {
      const r = selectPassages(passages([10, 20, 30, 5]), { fullContextTokens: 59 }, none);
      expect(r.mode).toBe('fallback');
      expect(ordinalsOf(r)).toEqual([0, 1]);
      expect(r).toMatchObject({ tokenEstimate: 30, documentTokens: 65, hits: [] });
    }
  });

  it('falls back when no hit refers to a known passage', () => {
    const r = selectPassages(passages([10, 20, 30]), { fullContextTokens: 40 }, hits(7, 9));
    expect(r.mode).toBe('fallback');
  });

  it('always sends at least one passage, even when the first exceeds the budget', () => {
    const r = selectPassages(passages([100, 1]), { fullContextTokens: 50 });
    expect(r.mode).toBe('fallback');
    expect(ordinalsOf(r)).toEqual([0]);
  });

  it('returns no passages for an empty list (full mode, nothing to send)', () => {
    expect(selectPassages([], { fullContextTokens: 10 })).toMatchObject({ mode: 'full', passages: [] });
  });
});

describe('ranked selection', () => {
  const doc = passages(Array(20).fill(10)); // 200 tokens

  it('adds ±1 neighbours of each hit and returns passages in document order', () => {
    const r = selectPassages(doc, { fullContextTokens: 100 }, hits(12, 3));
    expect(r.mode).toBe('ranked');
    expect(ordinalsOf(r)).toEqual([2, 3, 4, 11, 12, 13]);
    expect(r.tokenEstimate).toBe(60);
  });

  it('records each hit with its passage id, 1-based rank and score', () => {
    const r = selectPassages(doc, { fullContextTokens: 100 }, [
      { ordinal: 12, score: 0.9 },
      { ordinal: 3, score: 0.4 },
    ]);
    expect(r.hits).toEqual([
      { passageId: 'p12', ordinal: 12, rank: 1, score: 0.9 },
      { passageId: 'p3', ordinal: 3, rank: 2, score: 0.4 },
    ]);
  });

  it('dedupes overlapping neighbourhoods and hits that are each other’s neighbours', () => {
    const r = selectPassages(doc, { fullContextTokens: 199 }, hits(5, 6, 7, 6));
    expect(r.mode).toBe('ranked');
    expect(ordinalsOf(r)).toEqual([4, 5, 6, 7, 8]);
    expect(r.tokenEstimate).toBe(50);
    expect(r.hits.map((h) => h.ordinal)).toEqual([5, 6, 7]); // the repeated hit is recorded once
  });

  it('does not step outside the document at either end', () => {
    const r = selectPassages(doc, { fullContextTokens: 100 }, hits(0, 19));
    expect(ordinalsOf(r)).toEqual([0, 1, 18, 19]);
  });

  it('fills the budget with hits before neighbours, in rank order', () => {
    // Budget fits 4 passages: hits 10, 2, 15 first, then the best hit's left neighbour.
    const r = selectPassages(doc, { fullContextTokens: 40 }, hits(10, 2, 15));
    expect(ordinalsOf(r)).toEqual([2, 9, 10, 15]);
    expect(r.tokenEstimate).toBe(40);
  });

  it('skips passages that do not fit but keeps smaller later ones', () => {
    const uneven = passages([10, 10, 50, 10, 10, 10]); // 100 tokens
    const r = selectPassages(uneven, { fullContextTokens: 45 }, hits(2, 4));
    // Hit 2 (50) is first and alone exceeds the budget, so it is still sent; hit 4 then does not fit.
    expect(ordinalsOf(r)).toEqual([2]);
    const r2 = selectPassages(uneven, { fullContextTokens: 45 }, hits(4, 2));
    // Hit 4 (10) in; hit 2 (50) would exceed 45 → skipped; neighbours 3 and 5 still fit.
    expect(ordinalsOf(r2)).toEqual([3, 4, 5]);
    expect(r2.tokenEstimate).toBe(30);
    expect(r2.hits.map((h) => h.ordinal)).toEqual([4, 2]); // a hit cut by the budget is still recorded
  });

  it(`considers at most the top ${RANKED_TOP_K} hits`, () => {
    const many = hits(...Array.from({ length: 12 }, (_, i) => i * 2));
    const r = selectPassages(passages(Array(30).fill(1)), { fullContextTokens: 29 }, many);
    expect(r.hits).toHaveLength(RANKED_TOP_K);
    expect(r.passages.some((p) => p.ordinal === 22)).toBe(false); // hit #12 ignored, and so are its neighbours
  });

  it('ignores hits for unknown ordinals', () => {
    const r = selectPassages(doc, { fullContextTokens: 100 }, hits(99, 4));
    expect(ordinalsOf(r)).toEqual([3, 4, 5]);
    expect(r.hits).toEqual([{ passageId: 'p4', ordinal: 4, rank: 2, score: 0.99 }]);
  });
});
