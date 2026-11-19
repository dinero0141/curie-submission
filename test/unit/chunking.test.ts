import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  ChunkingError,
  chunkDocument,
  estimateTokens,
  type DocumentFormat,
  type Passage,
} from '../../src/domain/chunking.js';

const SAMPLE = readFileSync(new URL('../../samples/harbor-archive.md', import.meta.url), 'utf8');

const sentenceTexts = (content: string, passages: Passage[]) =>
  passages.flatMap((p) => p.sentences.map((s) => content.slice(s.start, s.end)));

/** ATX heading lines as the test sees them (outside fences); good enough for these fixtures. */
function atxHeadings(content: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let inFence = false;
  const re = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (let m = re.exec(content); m && m[0] !== ''; m = re.exec(content)) {
    const line = m[0].replace(/[\r\n]+$/, '');
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    else if (!inFence) {
      const h = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (h) out.push({ start: m.index, text: (h[1] ?? '').trim() });
    }
  }
  return out;
}

/** Shared invariants every chunking result must satisfy. */
function assertInvariants(content: string, format: DocumentFormat, passages: Passage[], limit: number) {
  expect(passages.length).toBeGreaterThan(0);
  let prevEnd = 0;
  passages.forEach((p, i) => {
    expect(p.ordinal).toBe(i);
    expect(p.sentences.length).toBeGreaterThanOrEqual(1);
    expect(p.start).toBe(p.sentences[0]!.start);
    expect(p.end).toBe(p.sentences.at(-1)!.end);
    expect(p.text).toBe(content.slice(p.start, p.end));
    expect(p.tokenEstimate).toBe(estimateTokens(p.text));
    if (p.sentences.length > 1) expect(p.tokenEstimate).toBeLessThanOrEqual(limit);
    for (const s of p.sentences) {
      expect(s.start).toBeGreaterThanOrEqual(prevEnd); // ordered, non-overlapping across the document
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end).toBeLessThanOrEqual(content.length);
      const text = content.slice(s.start, s.end);
      expect(text.trim()).toBe(text);
      expect(text.length).toBeGreaterThan(0);
      expect(estimateTokens(text)).toBeLessThanOrEqual(limit); // hard-split pieces fit too
      prevEnd = s.end;
    }
  });

  if (format === 'markdown') {
    const headings = atxHeadings(content);
    for (const p of passages) {
      // never crosses a heading line
      expect(headings.some((h) => h.start > p.start && h.start < p.end)).toBe(false);
      const nearest = headings.filter((h) => h.start < p.start).at(-1);
      expect(p.heading).toBe(nearest && nearest.text !== '' ? nearest.text : null);
    }
  } else {
    // plain text: every non-whitespace char covered exactly once
    const covered = new Uint8Array(content.length);
    for (const p of passages) for (const s of p.sentences) for (let i = s.start; i < s.end; i++) covered[i]!++;
    for (let i = 0; i < content.length; i++) {
      if (/\s/.test(content[i]!)) continue;
      expect(covered[i], `char ${i} ${JSON.stringify(content[i])}`).toBe(1);
    }
    for (const p of passages) expect(p.heading).toBeNull();
  }
}

function chunk(content: string, format: DocumentFormat = 'markdown', passageTokens = 400) {
  const passages = chunkDocument(content, format, { passageTokens });
  assertInvariants(content, format, passages, passageTokens);
  return passages;
}

function expectEmpty(content: string, format: DocumentFormat) {
  try {
    chunkDocument(content, format);
    expect.unreachable('expected ChunkingError');
  } catch (err) {
    expect(err).toBeInstanceOf(ChunkingError);
    expect((err as ChunkingError).code).toBe('empty_after_parse');
  }
}

describe('estimateTokens', () => {
  it('is ceil(length / CHARS_PER_TOKEN)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('a'.repeat(CHARS_PER_TOKEN * 3 + 1))).toBe(4);
  });
});

describe('chunkDocument — sample document', () => {
  const passages = chunk(SAMPLE);

  it('yields the expected section headings', () => {
    const headings = [...new Set(passages.map((p) => p.heading))];
    expect(headings).toEqual([
      'Harbor Archive retrieval pilot',
      'Purpose and setup',
      'Results',
      'Decision',
      'Limitations',
    ]);
  });

  it('splits sentences without breaking decimals or dates, and never includes heading lines', () => {
    const texts = sentenceTexts(SAMPLE, passages);
    expect(texts).toContain('Keyword search returned a relevant passage for 28 of the 40 questions.');
    expect(texts).toContain(
      'Median response time was 0.7 seconds for keyword search and 1.2 seconds for the hybrid prototype.',
    );
    expect(texts).toContain('Mira Chen owned the limited pilot.');
    expect(texts).toContain('The team planned to review the next results on 8 April 2026.');
    expect(texts.some((t) => t.includes('#'))).toBe(false);
    expect(texts.some((t) => t === 'Results')).toBe(false);
  });

  it('fits a short section into one passage at the default size', () => {
    expect(passages.filter((p) => p.heading === 'Results')).toHaveLength(1);
  });

  it('packs greedily into more passages under a small token limit, never crossing headings', () => {
    // 60 tokens = 240 chars: above the longest sample sentence, so no hard splits, only more passages
    const small = chunk(SAMPLE, 'markdown', 60);
    expect(small.length).toBeGreaterThan(passages.length);
    expect(small.filter((p) => p.heading === 'Results').length).toBeGreaterThan(1);
    expect(sentenceTexts(SAMPLE, small)).toEqual(sentenceTexts(SAMPLE, passages));
  });
});

describe('chunkDocument — markdown edge cases', () => {
  it('handles CRLF line endings with identical sentences', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const lf = sentenceTexts(SAMPLE, chunk(SAMPLE));
    const got = sentenceTexts(crlf, chunk(crlf));
    expect(got).toEqual(lf);
    expect(got.some((t) => t.includes('\r'))).toBe(false);
  });

  it('uses UTF-16 offsets for emoji and CJK', () => {
    const doc = '# 標題 🚀\n\n研究は成功した。次の段階に進む。\n\nRocket 🚀 launched. Party 🎉 time!\n';
    const passages = chunk(doc);
    expect(passages[0]!.heading).toBe('標題 🚀');
    expect(sentenceTexts(doc, passages)).toEqual([
      '研究は成功した。',
      '次の段階に進む。',
      'Rocket 🚀 launched.',
      'Party 🎉 time!',
    ]);
  });

  it('produces no passage for a heading with no body', () => {
    const doc = '# Empty section\n\n## Filled\n\nText under filled.\n\n## Trailing\n';
    const passages = chunk(doc);
    expect(passages).toHaveLength(1);
    expect(passages[0]!.heading).toBe('Filled');
    expect(sentenceTexts(doc, passages)).toEqual(['Text under filled.']);
  });

  it('treats each list item as its own block and excludes markers', () => {
    const doc = '# List\n\n- first item\n- second item\n  continued line\n* [x] done task\n1. numbered item\n2) other\n';
    expect(sentenceTexts(doc, chunk(doc))).toEqual([
      'first item',
      'second item\n  continued line',
      'done task',
      'numbered item',
      'other',
    ]);
  });

  it('joins hard-wrapped paragraph lines into one sentence', () => {
    const doc = 'A sentence that is\nwrapped across lines. Next one.\n';
    expect(sentenceTexts(doc, chunk(doc))).toEqual(['A sentence that is\nwrapped across lines.', 'Next one.']);
  });

  it('strips blockquote markers, ignores headings inside code fences, skips thematic breaks', () => {
    const doc = [
      '# Top',
      '',
      '> Quoted first. Quoted',
      '> second.',
      '',
      '---',
      '',
      '```python',
      '# not a heading',
      'x = 1',
      '```',
      '',
      'After code.',
    ].join('\n');
    const passages = chunk(doc);
    expect(new Set(passages.map((p) => p.heading))).toEqual(new Set(['Top']));
    expect(sentenceTexts(doc, passages)).toEqual([
      'Quoted first.',
      'Quoted\n> second.',
      '# not a heading',
      'x = 1',
      'After code.',
    ]);
  });

  it('recognises setext headings and table rows', () => {
    const doc = 'Title\n=====\n\nIntro text.\n\nPart two\n--------\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    const passages = chunkDocument(doc, 'markdown');
    expect(passages.map((p) => p.heading)).toEqual(['Title', 'Part two']);
    expect(sentenceTexts(doc, passages)).toEqual(['Intro text.', 'a | b', '1 | 2']);
  });

  it('hard-splits a 5,000-char sentence at whitespace', () => {
    const words = Array.from({ length: 900 }, (_, i) => `word${i % 10}`).join(' ');
    const doc = `# Long\n\n${words.slice(0, 5000).trimEnd()}.\n`;
    const passages = chunk(doc);
    const pieces = passages.flatMap((p) => p.sentences);
    expect(pieces.length).toBeGreaterThanOrEqual(4);
    for (const s of pieces) {
      expect(s.end - s.start).toBeLessThanOrEqual(400 * CHARS_PER_TOKEN);
      // split at whitespace: never mid-word
      expect(s.end === doc.length || /\s/.test(doc[s.end]!)).toBe(true);
      expect(/\s/.test(doc[s.start - 1]!)).toBe(true);
    }
  });

  it('hard-splits a whitespace-free run without breaking surrogate pairs', () => {
    const doc = '🚀'.repeat(300); // 600 UTF-16 units, no whitespace
    const passages = chunk(doc, 'text', 50);
    for (const p of passages) {
      for (const s of p.sentences) {
        const first = doc.charCodeAt(s.start);
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      }
    }
  });

  it('rejects empty, whitespace-only and syntax-only markdown', () => {
    expectEmpty('', 'markdown');
    expectEmpty('   \n\n\t\r\n', 'markdown');
    expectEmpty('# Title\n\n## Sub\n\n---\n\n```\n```\n\n- \n', 'markdown');
  });

  it('rejects documents above maxPassages', () => {
    try {
      chunkDocument(SAMPLE, 'markdown', { passageTokens: 30, maxPassages: 3 });
      expect.unreachable('expected ChunkingError');
    } catch (err) {
      expect((err as ChunkingError).code).toBe('too_many_passages');
    }
  });
});

describe('chunkDocument — plain text', () => {
  it('splits blank-line paragraphs, keeps markdown syntax as content, covers every char', () => {
    const doc = '# not a heading\n\nFirst paragraph. Second sentence!\r\n\r\n- dash stays\nwrapped line\n\n\n  Last one?  ';
    const passages = chunk(doc, 'text');
    expect(sentenceTexts(doc, passages)).toEqual([
      '# not a heading',
      'First paragraph.',
      'Second sentence!',
      '- dash stays\nwrapped line',
      'Last one?',
    ]);
  });

  it('covers every char of the sample read as plain text', () => {
    chunk(SAMPLE, 'text', 60);
  });

  it('rejects empty and whitespace-only text', () => {
    expectEmpty('', 'text');
    expectEmpty(' \n \r\n\t', 'text');
  });
});
