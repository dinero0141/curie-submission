import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkSmokeAnswer,
  dropSummary,
  FALLBACK_KEYWORD_ANSWER,
  formatSmokeRow,
  SMOKE_QUESTIONS,
  toAnswerView,
} from '../../scripts/smoke-check.js';
import { NOT_FOUND_MESSAGE, type Citation, type ResolvedAnswer } from '../../src/domain/citations.js';

const SAMPLE = readFileSync(new URL('../../samples/harbor-archive.md', import.meta.url), 'utf8');

const cite = (quote: string): Citation => {
  const startOffset = SAMPLE.indexOf(quote);
  if (startOffset < 0) throw new Error(`not in sample: ${quote}`);
  return { quote, startOffset, endOffset: startOffset + quote.length, heading: 'Results', passageId: 'p2', answerStart: 0, answerEnd: 5 };
};

const KEYWORD = 'Keyword search returned a relevant passage for 28 of the 40 questions.';
const HYBRID = 'The hybrid prototype returned a relevant passage for 34 of the 40 questions.';

const answered = (...quotes: string[]): ResolvedAnswer => ({
  answerable: true,
  text: 'Answer.',
  citations: quotes.map(cite),
  dropped: [],
  rawText: 'Answer.',
  notFoundReason: null,
});
const notFound: ResolvedAnswer = {
  answerable: false,
  text: NOT_FOUND_MESSAGE,
  citations: [],
  dropped: [],
  rawText: 'NOT_IN_DOCUMENT: no budget',
  notFoundReason: 'not_in_document',
};
const failedAs = (notFoundReason: 'truncated' | 'unverified'): ResolvedAnswer => ({ ...notFound, text: '', notFoundReason });

const expectOf = (id: string) => SMOKE_QUESTIONS.find((q) => q.id === id)!.expect;

describe('smoke questions', () => {
  it('cover an answerable question, a not-found one and a follow-up, with expectations the sample satisfies', () => {
    expect(SMOKE_QUESTIONS.map((q) => q.id)).toEqual(['keyword', 'budget', 'hybrid-followup']);
    expect(SMOKE_QUESTIONS.filter((q) => q.followUp).map((q) => q.id)).toEqual(['hybrid-followup']);
    expect(checkSmokeAnswer(answered(KEYWORD), expectOf('keyword'), SAMPLE).pass).toBe(true);
    expect(checkSmokeAnswer(notFound, expectOf('budget'), SAMPLE).pass).toBe(true);
    expect(checkSmokeAnswer(answered(HYBRID), expectOf('hybrid-followup'), SAMPLE).pass).toBe(true);
    expect(SAMPLE).toContain(FALLBACK_KEYWORD_ANSWER);
  });
});

describe('checkSmokeAnswer', () => {
  it('fails an answer whose quotes miss the expected text', () => {
    const r = checkSmokeAnswer(answered(HYBRID), expectOf('keyword'), SAMPLE);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('28 of the 40');
  });

  it('fails a not-found answer where an answer was expected, and an answer where not-found was expected', () => {
    expect(checkSmokeAnswer(notFound, expectOf('keyword'), SAMPLE).pass).toBe(false);
    expect(checkSmokeAnswer(answered(KEYWORD), expectOf('budget'), SAMPLE).pass).toBe(false);
  });

  it('fails truncated and unverified results with the processor error code', () => {
    expect(checkSmokeAnswer(failedAs('truncated'), expectOf('keyword'), SAMPLE).reason).toContain('answer_truncated');
    expect(checkSmokeAnswer(failedAs('unverified'), expectOf('budget'), SAMPLE).reason).toContain('citations_unverified');
  });

  it('fails a citation whose offsets do not slice the content to its quote', () => {
    const bad = answered(KEYWORD);
    bad.citations[0]!.startOffset += 1;
    expect(checkSmokeAnswer(bad, expectOf('keyword'), SAMPLE)).toMatchObject({ pass: false, reason: expect.stringContaining('does not slice') });
  });
});

describe('toAnswerView', () => {
  it('maps a resolved answer to what the processor stores', () => {
    expect(toAnswerView(answered(KEYWORD))).toMatchObject({ status: 'completed', answerable: true, error: null });
    expect(toAnswerView(notFound)).toMatchObject({ status: 'completed', answerable: false, content: NOT_FOUND_MESSAGE, citations: [] });
    expect(toAnswerView(failedAs('unverified'))).toMatchObject({ status: 'failed', error: { code: 'citations_unverified' } });
    expect(toAnswerView(failedAs('truncated'))).toMatchObject({ status: 'failed', error: { code: 'answer_truncated' } });
  });
});

describe('report formatting', () => {
  it('summarises drop reasons with counts', () => {
    expect(dropSummary([])).toBe('none');
    expect(dropSummary([{ reason: 'cited_text_mismatch' }, { reason: 'block_out_of_range' }, { reason: 'cited_text_mismatch' }])).toBe(
      'cited_text_mismatch×2, block_out_of_range×1',
    );
  });

  it('prints outcome, citation count, quotes with offsets, drops, stop reason and usage', () => {
    const resolved = { ...answered(KEYWORD), dropped: [{ reason: 'cited_text_mismatch' as const, answerBlock: 0, citation: {} }] };
    const out = formatSmokeRow({
      id: 'keyword',
      question: 'How many?',
      resolved,
      stopReason: 'end_turn',
      model: 'gemini-3.8-flash-001',
      usage: { totalTokenCount: 990 },
      seconds: 1.234,
      check: checkSmokeAnswer(resolved, expectOf('keyword'), SAMPLE),
    });
    const c = resolved.citations[0]!;
    expect(out).toContain('PASS [keyword] How many?');
    expect(out).toContain('outcome: answerable; verified citations: 1; dropped: cited_text_mismatch×1');
    expect(out).toContain('stopReason: end_turn; model: gemini-3.8-flash-001; 1.2 s; usage: {"totalTokenCount":990}');
    expect(out).toContain(`quote [${c.startOffset}, ${c.endOffset}): ${JSON.stringify(KEYWORD)}`);
  });

  it('shows the raw model text for a not-found answer', () => {
    const out = formatSmokeRow({
      id: 'budget',
      question: 'Budget?',
      resolved: notFound,
      stopReason: 'end_turn',
      model: 'm',
      usage: null,
      seconds: 1,
      check: checkSmokeAnswer(notFound, expectOf('budget'), SAMPLE),
    });
    expect(out).toContain('outcome: not_in_document; verified citations: 0');
    expect(out).toContain('answer: NOT_IN_DOCUMENT: no budget');
  });
});
