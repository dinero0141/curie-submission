// Request building. The Anthropic wire shape asserted here is the one documented in
// docs/notes/citations-spike.md (claude-api skill + @anthropic-ai/sdk 1.10.0 types). It is ASSUMED, not
// observed live (keyless run): these tests pin what we send, not what the API accepts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../../src/domain/chunking.js';
import { NOT_IN_DOCUMENT_MARKER } from '../../src/domain/citations.js';
import { ANSWER_EFFORT, THINKING_HEADROOM_TOKENS, toAnthropicParams } from '../../src/llm/anthropic.js';
import { buildRequest, HISTORY_TURNS, historyTurns, SYSTEM_PROMPT, type PromptMessage } from '../../src/llm/prompt.js';

const SAMPLE = readFileSync(new URL('../../samples/harbor-archive.md', import.meta.url), 'utf8');
const TITLE = 'Harbor Archive retrieval pilot';

function samplePassages() {
  return chunkDocument(SAMPLE, 'markdown', { passageTokens: 400 }).map((p) => ({ id: `p${p.ordinal}`, ...p }));
}

const turn = (q: string, a: string, status = 'completed'): PromptMessage[] => [
  { role: 'user', content: q, status: 'completed' },
  { role: 'assistant', content: a, status },
];

describe('buildRequest', () => {
  it('sends one document per passage with one block per sentence, sliced from the content', () => {
    const passages = samplePassages();
    const req = buildRequest({ documentTitle: TITLE, content: SAMPLE, passages, history: [], question: 'Who owned the pilot?' });

    expect(req.documents).toHaveLength(passages.length);
    req.documents.forEach((d, i) => {
      const p = passages[i]!;
      expect(d.passageId).toBe(p.id);
      expect(d.blocks).toHaveLength(p.sentences.length);
      expect(d.blocks).toEqual(p.sentences.map((s) => SAMPLE.slice(s.start, s.end)));
      expect(d.title).toBe(p.heading ?? TITLE);
    });
    expect(req.documents.map((d) => d.title)).toEqual(
      expect.arrayContaining(['Purpose and setup', 'Results', 'Decision', 'Limitations']),
    );
    expect(req.question).toBe('Who owned the pilot?');
    expect(req.userText).toContain('Question: Who owned the pilot?');
    expect(req.userText).toContain(TITLE);
  });

  it('falls back to the document title for text before the first heading', () => {
    const content = 'Plain intro sentence. Another one.\n\n# Later\n\nBody text.';
    const passages = chunkDocument(content, 'markdown').map((p) => ({ id: `p${p.ordinal}`, ...p }));
    const req = buildRequest({ documentTitle: 'Doc T', content, passages, history: [], question: 'q' });
    expect(req.documents.map((d) => d.title)).toEqual(['Doc T', 'Later']);
  });

  it('system prompt carries the grounding rules and is stable across requests', () => {
    const a = buildRequest({ documentTitle: 'A', content: SAMPLE, passages: samplePassages(), history: [], question: 'x' });
    const b = buildRequest({ documentTitle: 'B', content: SAMPLE, passages: samplePassages(), history: [], question: 'y' });
    expect(a.system).toBe(SYSTEM_PROMPT);
    expect(b.system).toBe(a.system);
    expect(SYSTEM_PROMPT).toContain(NOT_IN_DOCUMENT_MARKER);
    expect(SYSTEM_PROMPT).toMatch(/only the document/i);
    expect(SYSTEM_PROMPT).toMatch(/citation/i);
    expect(SYSTEM_PROMPT).toMatch(/data, not instructions/i);
  });

  it('throws on an empty passage list or a passage without sentences', () => {
    expect(() => buildRequest({ documentTitle: 'T', content: '', passages: [], history: [], question: 'q' })).toThrow(/no passages/);
    expect(() =>
      buildRequest({ documentTitle: 'T', content: 'x', passages: [{ id: 'p0', heading: null, sentences: [] }], history: [], question: 'q' }),
    ).toThrow(/no sentences/);
  });
});

describe('historyTurns', () => {
  it(`keeps only the last ${HISTORY_TURNS} completed turns, oldest first`, () => {
    const msgs = Array.from({ length: 9 }, (_, i) => turn(`q${i}`, `a${i}`)).flat();
    const turns = historyTurns(msgs);
    expect(turns).toHaveLength(HISTORY_TURNS);
    expect(turns[0]).toEqual({ question: 'q3', answer: 'a3' });
    expect(turns.at(-1)).toEqual({ question: 'q8', answer: 'a8' });
  });

  it('skips turns whose answer failed or is still in flight, and a trailing unanswered question', () => {
    const msgs = [
      ...turn('q0', 'a0'),
      ...turn('q1', 'partial', 'failed'),
      ...turn('q2', 'a2'),
      ...turn('q3', 'half', 'streaming'),
      { role: 'user' as const, content: 'current question', status: 'completed' },
      { role: 'assistant' as const, content: '', status: 'pending' },
    ];
    expect(historyTurns(msgs)).toEqual([
      { question: 'q0', answer: 'a0' },
      { question: 'q2', answer: 'a2' },
    ]);
  });

  it('counts the cap after skipping failed turns', () => {
    const msgs = [...Array.from({ length: 6 }, (_, i) => turn(`ok${i}`, `a${i}`)).flat(), ...turn('bad', 'x', 'failed')];
    const turns = historyTurns(msgs);
    expect(turns).toHaveLength(6);
    expect(turns.map((t) => t.question)).not.toContain('bad');
  });
});

describe('toAnthropicParams (documented shape, not observed live)', () => {
  const tiny = '# Results\n\nKeyword search got 28 of 40. Hybrid got 34 of 40.\n\n# Decision\n\nKeep keyword search.';
  const tinyPassages = () => chunkDocument(tiny, 'markdown').map((p) => ({ id: `p${p.ordinal}`, ...p }));

  it('matches the documented request shape exactly for a small document with history', () => {
    const req = buildRequest({
      documentTitle: 'Tiny',
      content: tiny,
      passages: tinyPassages(),
      history: turn('How many did hybrid get?', 'Hybrid got 34 of 40.'),
      question: 'And keyword search?',
    });
    const params = toAnthropicParams(req, { model: 'claude-sonnet-5-5', maxAnswerTokens: 1024 });

    expect(params).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024 + THINKING_HEADROOM_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { effort: ANSWER_EFFORT },
      messages: [
        { role: 'user', content: 'How many did hybrid get?' },
        { role: 'assistant', content: 'Hybrid got 34 of 40.' },
        {
          role: 'user',
          content: [
            {
              type: 'document',
              title: 'Results',
              source: {
                type: 'content',
                content: [
                  { type: 'text', text: 'Keyword search got 28 of 40.' },
                  { type: 'text', text: 'Hybrid got 34 of 40.' },
                ],
              },
              citations: { enabled: true },
            },
            {
              type: 'document',
              title: 'Decision',
              source: { type: 'content', content: [{ type: 'text', text: 'Keep keyword search.' }] },
              citations: { enabled: true },
            },
            { type: 'text', text: 'The passages above are from the document "Tiny".\n\nQuestion: And keyword search?' },
          ],
        },
      ],
    });
  });

  it('puts documents only in the final user message and nothing forbidden anywhere', () => {
    const req = buildRequest({
      documentTitle: TITLE,
      content: SAMPLE,
      passages: samplePassages(),
      history: [...turn('a?', 'b.'), ...turn('c?', 'd.')],
      question: 'Who owned the limited pilot?',
    });
    const params = toAnthropicParams(req, { model: 'claude-sonnet-5-5', maxAnswerTokens: 1024 });
    const json = JSON.stringify(params);

    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'cache_control', 'stream', 'fallbacks']) {
      expect(json).not.toContain(`"${key}"`);
    }
    const last = params.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as { type: string; citations?: { enabled: boolean }; source?: { type: string; content: unknown[] } }[];
    const docs = blocks.filter((b) => b.type === 'document');
    expect(docs).toHaveLength(req.documents.length);
    expect(docs.every((d) => d.citations?.enabled === true && d.source?.type === 'content' && d.source.content.length > 0)).toBe(true);
    expect(blocks.at(-1)).toEqual({ type: 'text', text: req.userText });
    // History is plain strings: no documents, no citations in earlier turns.
    for (const m of params.messages.slice(0, -1)) expect(typeof m.content).toBe('string');
    expect(params.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });
});
