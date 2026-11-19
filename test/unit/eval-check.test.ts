import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type AnswerView, checkAnswer, formatTable, parseEvalSuite } from '../../scripts/eval-check.js';

const DOC = 'Intro.\n\nKeyword search returned a relevant passage for 28 of the 40 questions.\n\nMira  Chen owned it.';
const at = (quote: string) => {
  const start = DOC.indexOf(quote);
  if (start < 0) throw new Error(`fixture quote not in DOC: ${quote}`);
  return { quote, startOffset: start, endOffset: start + quote.length };
};

const answered = (...quotes: string[]): AnswerView => ({
  status: 'completed',
  answerable: true,
  content: 'answer',
  citations: quotes.map(at),
  error: null,
});
const notFound: AnswerView = { status: 'completed', answerable: false, content: 'not found', citations: [], error: null };

describe('checkAnswer', () => {
  it('passes when a citation quote contains the expected substring', () => {
    const r = checkAnswer(answered('Intro.', 'Keyword search returned a relevant passage for 28 of the 40 questions.'), [
      { answerable: true, quoteIncludes: '28 of the 40' },
    ], DOC);
    expect(r).toEqual({ pass: true, reason: 'quote contains "28 of the 40"' });
  });

  it('matches case-insensitively with whitespace collapsed', () => {
    const r = checkAnswer(answered('Mira  Chen owned it.'), [{ answerable: true, quoteIncludes: 'mira chen' }], DOC);
    expect(r.pass).toBe(true);
  });

  it('fails when the substring is only in the answer text, not in a quote', () => {
    const a = { ...answered('Intro.'), content: 'It was 28 of the 40.' };
    const r = checkAnswer(a, [{ answerable: true, quoteIncludes: '28 of the 40' }], DOC);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('no citation quote contains "28 of the 40"');
  });

  it('fails an expected answer that came back not found', () => {
    const r = checkAnswer(notFound, [{ answerable: true, quoteIncludes: 'Mira' }], DOC);
    expect(r).toEqual({ pass: false, reason: 'expected an answer quoting "Mira", got not found' });
  });

  it('passes an expected not-found and fails an answered one', () => {
    expect(checkAnswer(notFound, [{ answerable: false }], DOC)).toEqual({ pass: true, reason: 'not found, as expected' });
    const r = checkAnswer(answered('Intro.'), [{ answerable: false }], DOC);
    expect(r).toEqual({ pass: false, reason: 'expected not found, got answerable=true' });
  });

  it('fails not-found that still carries citations', () => {
    const r = checkAnswer({ ...notFound, citations: [at('Intro.')] }, [{ answerable: false }], DOC);
    expect(r).toEqual({ pass: false, reason: 'not found but 1 citation(s)' });
  });

  it('passes when any one of several outcomes matches, and lists all on failure', () => {
    const expectAny = [{ answerable: false as const }, { answerable: true as const, quoteIncludes: 'Mira' }];
    expect(checkAnswer(answered('Mira  Chen owned it.'), expectAny, DOC).pass).toBe(true);
    expect(checkAnswer(notFound, expectAny, DOC).pass).toBe(true);
    const r = checkAnswer(answered('Intro.'), expectAny, DOC);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('expected not found, got answerable=true; or no citation quote contains "Mira" (1 citation(s))');
  });

  it('fails a citation whose offsets do not slice to its quote, even if the substring matches', () => {
    const c = at('Mira  Chen owned it.');
    const a = { ...answered(), citations: [{ ...c, startOffset: c.startOffset + 1, endOffset: c.endOffset + 1 }] };
    const r = checkAnswer(a, [{ answerable: true, quoteIncludes: 'Mira' }], DOC);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/does not slice to its quote/);
  });

  it('fails a failed answer with its error code', () => {
    const a: AnswerView = { ...notFound, status: 'failed', answerable: null, error: { code: 'model_unavailable', message: '529' } };
    expect(checkAnswer(a, [{ answerable: false }], DOC)).toEqual({
      pass: false,
      reason: 'status failed (model_unavailable: 529)',
    });
  });
});

describe('parseEvalSuite', () => {
  it('accepts the committed question file, including the follow-up chain', () => {
    const suite = parseEvalSuite(JSON.parse(readFileSync(new URL('../../samples/eval-questions.json', import.meta.url), 'utf8')));
    expect(suite.document.path).toBe('samples/harbor-archive.md');
    expect(suite.conversations[0]!.map((t) => t.id)).toEqual(['hybrid-correct', 'keyword-followup']);
    expect(suite.conversations.flat()).toHaveLength(7);
  });

  it('rejects missing quoteIncludes, unknown keys, empty expect and duplicate ids', () => {
    const doc = { path: 'x.md', title: 'x', format: 'markdown' };
    const turn = (over: object) => ({ id: 'a', question: 'q?', expect: [{ answerable: false }], ...over });
    expect(() => parseEvalSuite({ document: doc, conversations: [[turn({ expect: [{ answerable: true }] })]] })).toThrow(
      /invalid eval file/,
    );
    expect(() => parseEvalSuite({ document: doc, conversations: [[turn({ extra: 1 })]] })).toThrow(/invalid eval file/);
    expect(() => parseEvalSuite({ document: doc, conversations: [[turn({ expect: [] })]] })).toThrow(/invalid eval file/);
    expect(() => parseEvalSuite({ document: doc, conversations: [[turn({})], [turn({})]] })).toThrow(/duplicate turn id "a"/);
    expect(() => parseEvalSuite({ document: doc, conversations: [] })).toThrow(/invalid eval file/);
  });
});

describe('formatTable', () => {
  it('aligns columns, cuts long cells and ends with a pass count', () => {
    const out = formatTable([
      { id: 'one', question: 'Short?', pass: true, reason: 'ok', seconds: 1.234 },
      { id: 'two', question: 'q'.repeat(80), pass: false, reason: 'r'.repeat(120), seconds: null },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^result\s+id\s+question\s+secs\s+detail$/);
    expect(lines[2]).toMatch(/^PASS\s+one\s+Short\?\s+1\.2\s+ok$/);
    expect(lines[3]).toContain(`${'q'.repeat(59)}…`);
    expect(lines[3]).toContain(`${'r'.repeat(89)}…`);
    expect(lines[3]).toMatch(/^FAIL\s+two\s+q+…\s+-\s+r+…$/);
    expect(lines.at(-1)).toBe('1/2 passed');
  });
});
