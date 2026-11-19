// Built against the ASSUMED Citations shapes in docs/notes/citations-spike.md (from the claude-api skill and
// @anthropic-ai/sdk 1.10.0 types). They were not observed live: the build had no API key.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkDocument, type Passage } from '../../src/domain/chunking.js';
import {
  NOT_FOUND_IN_SEARCHED_MESSAGE,
  NOT_FOUND_MESSAGE,
  NOT_IN_DOCUMENT_MARKER,
  resolveCitations,
  toSentDocument,
  type RawAnswer,
  type SentDocument,
} from '../../src/domain/citations.js';

const SAMPLE = readFileSync(new URL('../../samples/harbor-archive.md', import.meta.url), 'utf8');

function setup(content: string, format: 'markdown' | 'text' = 'markdown') {
  const passages: Passage[] = chunkDocument(content, format, { passageTokens: 400 });
  const docs: SentDocument[] = passages.map((p) => toSentDocument({ id: `p${p.ordinal}`, ...p }, content));
  return { content, passages, docs };
}

/** Assumed `content_block_location` shape; `cited_text` defaults to the cited blocks joined with no separator. */
function cite(docs: SentDocument[], documentIndex: number, start: number, end: number, citedText?: string) {
  return {
    type: 'content_block_location',
    cited_text: citedText ?? docs[documentIndex]!.blocks.slice(start, end).join(''),
    document_index: documentIndex,
    document_title: docs[documentIndex]?.heading ?? null,
    start_block_index: start,
    end_block_index: end,
    file_id: null,
  };
}

function answer(...blocks: { text: string; citations?: unknown[] }[]): RawAnswer {
  return {
    blocks: blocks.map((b) => ({ text: b.text, citations: b.citations ?? [] })),
    stopReason: 'end_turn',
    usage: {},
    model: 'fake',
  };
}

const docIndexByHeading = (docs: SentDocument[], heading: string) => {
  const i = docs.findIndex((d) => d.heading === heading);
  if (i < 0) throw new Error(`no passage under ${heading}`);
  return i;
};

describe('toSentDocument', () => {
  it('sends one block per sentence, each exactly content.slice(span)', () => {
    const { content, passages, docs } = setup(SAMPLE);
    expect(docs).toHaveLength(passages.length);
    docs.forEach((d, i) => {
      expect(d.passageId).toBe(`p${i}`);
      expect(d.heading).toBe(passages[i]!.heading);
      expect(d.blocks).toEqual(passages[i]!.sentences.map((s) => content.slice(s.start, s.end)));
    });
  });
});

describe('resolveCitations — mapping', () => {
  const { content, docs } = setup(SAMPLE);
  const results = docIndexByHeading(docs, 'Results');

  it('maps a single-block citation to that sentence span (end_block_index exclusive)', () => {
    const r = resolveCitations(answer({ text: 'It found 34 of 40.', citations: [cite(docs, results, 1, 2)] }), docs, content);
    expect(r.answerable).toBe(true);
    expect(r.dropped).toEqual([]);
    expect(r.citations).toHaveLength(1);
    const c = r.citations[0]!;
    const span = docs[results]!.sentences[1]!;
    expect(c).toMatchObject({ startOffset: span.start, endOffset: span.end, heading: 'Results', passageId: `p${results}` });
    expect(c.quote).toBe('The hybrid prototype returned a relevant passage for 34 of the 40 questions.');
    expect(c.quote).toBe(content.slice(c.startOffset, c.endOffset));
  });

  it('maps a multi-block citation to [sentences[start].start, sentences[end-1].end), whitespace included', () => {
    const r = resolveCitations(answer({ text: 'Both counts.', citations: [cite(docs, results, 0, 2)] }), docs, content);
    const c = r.citations[0]!;
    const s = docs[results]!.sentences;
    expect(c.startOffset).toBe(s[0]!.start);
    expect(c.endOffset).toBe(s[1]!.end);
    expect(c.quote).toBe(content.slice(s[0]!.start, s[1]!.end));
    expect(c.quote).toContain('\n\nThe hybrid prototype');
  });

  it('uses document_index to pick the passage', () => {
    const decision = docIndexByHeading(docs, 'Decision');
    const r = resolveCitations(answer({ text: 'Mira Chen.', citations: [cite(docs, decision, 2, 3)] }), docs, content);
    expect(r.citations[0]).toMatchObject({ passageId: `p${decision}`, heading: 'Decision' });
    expect(r.citations[0]!.quote).toBe('Mira Chen owned the limited pilot.');
  });

  it('computes offsets in UTF-16 code units (emoji, accents)', () => {
    const t = setup('Café ☕ opens at 7. 😀 Tea costs 3€. Done.', 'text');
    const r = resolveCitations(answer({ text: 'Tea: 3€.', citations: [cite(t.docs, 0, 1, 2)] }), t.docs, t.content);
    expect(r.citations[0]!.quote).toBe('😀 Tea costs 3€.');
    expect(r.citations[0]!.startOffset).toBe(t.content.indexOf('😀'));
  });

  it('computes answerStart/answerEnd over the concatenated text blocks', () => {
    const r = resolveCitations(
      answer(
        { text: 'According to the note, ' },
        { text: 'the hybrid prototype found 34 of 40', citations: [cite(docs, results, 1, 2)] },
        { text: ', while ' },
        { text: 'keyword search found 28.', citations: [cite(docs, results, 0, 1)] },
      ),
      docs,
      content,
    );
    expect(r.text).toBe('According to the note, the hybrid prototype found 34 of 40, while keyword search found 28.');
    expect(r.rawText).toBe(r.text);
    const [a, b] = r.citations;
    expect(r.text.slice(a!.answerStart, a!.answerEnd)).toBe('the hybrid prototype found 34 of 40');
    expect(r.text.slice(b!.answerStart, b!.answerEnd)).toBe('keyword search found 28.');
  });

  it('merges adjacent duplicate citations into one with a widened answer range', () => {
    const c = cite(docs, results, 1, 2);
    const r = resolveCitations(
      answer({ text: 'Hybrid: ' }, { text: '34 of 40', citations: [c, { ...c }] }, { text: ' questions.', citations: [{ ...c }] }),
      docs,
      content,
    );
    expect(r.citations).toHaveLength(1);
    expect(r.text.slice(r.citations[0]!.answerStart, r.citations[0]!.answerEnd)).toBe('34 of 40 questions.');
  });

  it('keeps repeated citations that are not adjacent, and different spans in one block', () => {
    const one = cite(docs, results, 1, 2);
    const other = cite(docs, results, 0, 1);
    const r = resolveCitations(
      answer({ text: 'A', citations: [one, other] }, { text: ' and ' }, { text: 'B', citations: [{ ...one }] }),
      docs,
      content,
    );
    expect(r.citations.map((c) => c.startOffset)).toEqual([
      docs[results]!.sentences[1]!.start,
      docs[results]!.sentences[0]!.start,
      docs[results]!.sentences[1]!.start,
    ]);
  });
});

describe('resolveCitations — verification and dropping', () => {
  const { content, docs } = setup(SAMPLE);
  const results = docIndexByHeading(docs, 'Results');
  const good = () => cite(docs, results, 1, 2);
  const run = (...cs: unknown[]) => resolveCitations(answer({ text: 'Claim.', citations: [good(), ...cs] }), docs, content);

  it('accepts cited_text joined with any whitespace separator (separator is undocumented)', () => {
    for (const sep of ['', ' ', '\n', '\n\n']) {
      const citedText = docs[results]!.blocks.slice(0, 3).join(sep);
      const r = resolveCitations(answer({ text: 'x', citations: [cite(docs, results, 0, 3, citedText)] }), docs, content);
      expect(r.dropped, `separator ${JSON.stringify(sep)}`).toEqual([]);
      expect(r.citations).toHaveLength(1);
    }
  });

  it('drops a citation whose cited_text does not match the blocks we sent (forged text)', () => {
    const forged = cite(docs, results, 1, 2, 'The hybrid prototype returned a relevant passage for 40 of the 40 questions.');
    const r = run(forged);
    expect(r.citations).toHaveLength(1);
    expect(r.dropped).toEqual([expect.objectContaining({ reason: 'cited_text_mismatch', answerBlock: 0, citation: forged })]);
  });

  it('drops rather than misquotes if end_block_index were actually inclusive', () => {
    // If the API meant [start, end], cited_text would cover one block more than our [start, end) slice.
    const inclusive = cite(docs, results, 0, 1, docs[results]!.blocks.slice(0, 2).join(' '));
    expect(run(inclusive).dropped.map((d) => d.reason)).toEqual(['cited_text_mismatch']);
  });

  it('drops a citation with no cited_text (cannot cross-check the index semantics)', () => {
    const { cited_text: _, ...noText } = good();
    expect(run(noText).dropped.map((d) => d.reason)).toEqual(['cited_text_missing']);
  });

  it('drops out-of-range document indices', () => {
    for (const bad of [-1, docs.length, 1.5, '0', undefined]) {
      const c = { ...good(), document_index: bad };
      expect(run(c).dropped.map((d) => d.reason), String(bad)).toEqual(['document_out_of_range']);
    }
  });

  it('drops out-of-range or empty block ranges', () => {
    const n = docs[results]!.blocks.length;
    const cases: [unknown, unknown][] = [
      [-1, 1],
      [0, 0],
      [2, 1],
      [0, n + 1],
      [n, n + 1],
      [0.5, 1],
      [0, '1'],
      [undefined, 1],
    ];
    for (const [start, end] of cases) {
      const c = { ...good(), start_block_index: start, end_block_index: end };
      expect(run(c).dropped.map((d) => d.reason), `${start}..${end}`).toEqual(['block_out_of_range']);
    }
  });

  it('drops unsupported citation types and malformed entries', () => {
    const charLoc = { type: 'char_location', cited_text: 'x', document_index: 0, start_char_index: 0, end_char_index: 1 };
    expect(run(charLoc, null, 'text', 42).dropped.map((d) => d.reason)).toEqual([
      'unsupported_type',
      'malformed',
      'malformed',
      'malformed',
    ]);
  });

  it('quotes the Markdown syntax between cited sentences of different blocks (one contiguous slice)', () => {
    const md = '# List\n\n- First item.\n- Second item.\n';
    const { docs: d } = setup(md);
    const r = resolveCitations(answer({ text: 'Both.', citations: [cite(d, 0, 0, 2)] }), d, md);
    expect(r.citations[0]!.quote).toBe('First item.\n- Second item.');
  });

  it('stays answerable when at least one citation survives', () => {
    const r = run({ ...good(), document_index: 99 });
    expect(r.answerable).toBe(true);
    expect(r.citations).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
  });
});

describe('resolveCitations — not answerable', () => {
  const { content, docs } = setup(SAMPLE);
  const results = docIndexByHeading(docs, 'Results');

  it('treats a NOT_IN_DOCUMENT: reply as not answerable, strips citations, keeps raw text', () => {
    const raw = `${NOT_IN_DOCUMENT_MARKER} the note does not give the team size.`;
    for (const lead of ['', '  \n']) {
      const r = resolveCitations(
        answer({ text: lead + raw.slice(0, 20) }, { text: raw.slice(20), citations: [cite(docs, results, 0, 1)] }),
        docs,
        content,
      );
      expect(r).toMatchObject({ answerable: false, text: NOT_FOUND_MESSAGE, citations: [], notFoundReason: 'not_in_document' });
      expect(r.rawText).toBe(lead + raw);
    }
  });

  it('accepts a formatted or preceded marker when no citation survived', () => {
    for (const text of [
      '**NOT_IN_DOCUMENT:** the note does not give the team size.',
      '`NOT_IN_DOCUMENT:` the note does not give the team size.',
      '> NOT_IN_DOCUMENT: not stated.',
      '## NOT_IN_DOCUMENT - not stated.',
      '__NOT_IN_DOCUMENT__: not stated.',
      'not_in_document: not stated.',
      'NOT_IN_DOCUMENT not stated.',
      'NOT_IN_DOCUMENT',
      'I checked the passages. NOT_IN_DOCUMENT: the team size is not given.',
    ]) {
      const r = resolveCitations(answer({ text }), docs, content);
      expect(r, text).toMatchObject({ answerable: false, text: NOT_FOUND_MESSAGE, citations: [], notFoundReason: 'not_in_document' });
      expect(r.rawText).toBe(text);
    }
  });

  it('says only the searched parts lacked the answer when the model saw part of the document', () => {
    const marker = answer({ text: 'NOT_IN_DOCUMENT: not stated.' });
    expect(resolveCitations(marker, docs, content, { partial: true })).toMatchObject({
      answerable: false,
      text: NOT_FOUND_IN_SEARCHED_MESSAGE,
      notFoundReason: 'not_in_document',
    });
    // An answerable reply keeps the model text either way.
    const cited = answer({ text: 'Mira Chen.', citations: [cite(docs, docIndexByHeading(docs, 'Decision'), 2, 3)] });
    expect(resolveCitations(cited, docs, content, { partial: true })).toMatchObject({ answerable: true, text: 'Mira Chen.' });
  });

  it('treats a formatted marker at the start as not-found even with a verified citation', () => {
    const r = resolveCitations(answer({ text: '**NOT_IN_DOCUMENT:** no.', citations: [cite(docs, results, 0, 1)] }), docs, content);
    expect(r).toMatchObject({ answerable: false, citations: [], notFoundReason: 'not_in_document' });
  });

  it('does not take a longer word containing the marker as the marker', () => {
    for (const text of ['NOT_IN_DOCUMENTS: x', 'XNOT_IN_DOCUMENT: x', 'NOT_IN_DOCUMENT2 x']) {
      expect(resolveCitations(answer({ text }), docs, content).notFoundReason, text).toBe('unverified');
    }
  });

  it('reports a reply with no citations as unverified, not as not-in-document', () => {
    const r = resolveCitations(answer({ text: 'The team had twelve people.' }), docs, content);
    expect(r).toMatchObject({ answerable: false, text: '', citations: [], notFoundReason: 'unverified' });
    expect(r.rawText).toBe('The team had twelve people.');
  });

  it('reports a reply whose citations were all dropped as unverified (not as not-in-document) and lists them', () => {
    const r = resolveCitations(
      answer({ text: 'Claim.', citations: [cite(docs, results, 0, 1, 'invented'), { ...cite(docs, 0, 0, 1), document_index: 50 }] }),
      docs,
      content,
    );
    expect(r).toMatchObject({ answerable: false, text: '', citations: [], notFoundReason: 'unverified' });
    expect(r.text).not.toBe(NOT_FOUND_MESSAGE);
    expect(r.dropped.map((d) => d.reason)).toEqual(['cited_text_mismatch', 'document_out_of_range']);
  });

  it('reports a partial answer with a mid-text marker whose citations were all dropped as unverified', () => {
    const forged = cite(docs, results, 0, 1, 'forged cited text');
    const r = resolveCitations(
      answer(
        { text: 'The pilot was owned by Mira Chen.', citations: [forged] },
        { text: ` ${NOT_IN_DOCUMENT_MARKER} the funding is not stated.` },
      ),
      docs,
      content,
    );
    expect(r).toMatchObject({ answerable: false, text: '', citations: [], notFoundReason: 'unverified' });
    expect(r.dropped.map((d) => d.reason)).toEqual(['cited_text_mismatch']);
  });

  it('reports a shape mismatch that drops every citation (1-based indices, other type) as unverified', () => {
    const good = cite(docs, results, 0, 1);
    const oneBased = { ...good, start_block_index: 1, end_block_index: 2 };
    const otherType = { ...good, type: 'search_result_location' };
    const r = resolveCitations(answer({ text: 'A real answer.', citations: [oneBased, otherType] }), docs, content);
    expect(r).toMatchObject({ answerable: false, text: '', citations: [], notFoundReason: 'unverified' });
    expect(r.dropped.map((d) => d.reason)).toEqual(['cited_text_mismatch', 'unsupported_type']);
  });

  it('reports a max_tokens reply with no surviving citation as truncated, not as not-in-document', () => {
    const cut = { ...answer({ text: 'The hybrid prototype found a relevant' }), stopReason: 'max_tokens' };
    expect(resolveCitations(cut, docs, content)).toMatchObject({ answerable: false, citations: [], notFoundReason: 'truncated' });

    // A cut answer that already carries a verified citation stays answerable; an explicit marker stays not-found.
    const cited = { ...answer({ text: 'Claim', citations: [cite(docs, results, 0, 1)] }), stopReason: 'max_tokens' };
    expect(resolveCitations(cited, docs, content)).toMatchObject({ answerable: true, notFoundReason: null });
    const marker = { ...answer({ text: `${NOT_IN_DOCUMENT_MARKER} no` }), stopReason: 'max_tokens' };
    expect(resolveCitations(marker, docs, content).notFoundReason).toBe('not_in_document');
  });

  it('treats an empty reply as not answerable', () => {
    const r = resolveCitations(answer(), docs, content);
    expect(r).toMatchObject({ answerable: false, text: '', rawText: '', notFoundReason: 'unverified' });
  });

  it('does not treat the marker in the middle of a cited answer as not-found', () => {
    const r = resolveCitations(
      answer({ text: `Keyword search found 28 (not ${NOT_IN_DOCUMENT_MARKER} anything).`, citations: [cite(docs, results, 0, 1)] }),
      docs,
      content,
    );
    expect(r.answerable).toBe(true);
    // Also after a preamble: with a verified citation only a marker at the start counts.
    const preamble = resolveCitations(
      answer({ text: `I checked. ${NOT_IN_DOCUMENT_MARKER} no.`, citations: [cite(docs, results, 0, 1)] }),
      docs,
      content,
    );
    expect(preamble.answerable).toBe(true);
  });
});
