import { describe, expect, it } from 'vitest';
import { selectPassages } from '../../src/domain/retrieval.js';

const passages = (tokens: number[]) => tokens.map((t, i) => ({ id: `p${i}`, ordinal: i, tokenEstimate: t }));

describe('selectPassages (full / leading-passages fallback)', () => {
  it('sends the whole document in order when it fits the budget', () => {
    const r = selectPassages([...passages([10, 20, 30])].reverse(), { fullContextTokens: 60 });
    expect(r.mode).toBe('full');
    expect(r.passages.map((p) => p.ordinal)).toEqual([0, 1, 2]);
    expect(r).toMatchObject({ tokenEstimate: 60, documentTokens: 60 });
  });

  it('falls back to leading passages within the budget when the document is larger', () => {
    const r = selectPassages(passages([10, 20, 30, 5]), { fullContextTokens: 59 });
    expect(r.mode).toBe('fallback');
    expect(r.passages.map((p) => p.ordinal)).toEqual([0, 1]);
    expect(r).toMatchObject({ tokenEstimate: 30, documentTokens: 65 });
  });

  it('always sends at least one passage, even when the first exceeds the budget', () => {
    const r = selectPassages(passages([100, 1]), { fullContextTokens: 50 });
    expect(r.mode).toBe('fallback');
    expect(r.passages.map((p) => p.ordinal)).toEqual([0]);
  });

  it('returns no passages for an empty list (full mode, nothing to send)', () => {
    expect(selectPassages([], { fullContextTokens: 10 })).toMatchObject({ mode: 'full', passages: [] });
  });
});
