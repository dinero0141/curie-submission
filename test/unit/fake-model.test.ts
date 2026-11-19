import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../../src/domain/chunking.js';
import { NOT_FOUND_MESSAGE, resolveCitations } from '../../src/domain/citations.js';
import { classifyError, ModelRefusalError } from '../../src/llm/errors.js';
import { FakeModel, fakeCitation } from '../../src/llm/fake.js';
import { buildRequest } from '../../src/llm/prompt.js';

const SAMPLE = readFileSync(new URL('../../samples/harbor-archive.md', import.meta.url), 'utf8');
const req = (question: string) =>
  buildRequest({
    documentTitle: 'Harbor',
    content: SAMPLE,
    passages: chunkDocument(SAMPLE, 'markdown').map((p) => ({ id: `p${p.ordinal}`, ...p })),
    history: [],
    question,
  });
const live = () => new AbortController().signal;

describe('FakeModel', () => {
  it('default answer cites the first sentence of the first passage and verifies', async () => {
    const fake = new FakeModel();
    const r = req('Anything at all?');
    const deltas: string[] = [];
    const raw = await fake.generate(r, (t) => deltas.push(t), live());
    const resolved = resolveCitations(raw, r.documents, SAMPLE);
    expect(resolved.answerable).toBe(true);
    expect(resolved.citations).toHaveLength(1);
    expect(resolved.citations[0]!.quote).toBe(r.documents[0]!.blocks[0]);
    expect(deltas.join('')).toBe(resolved.text);
    expect(raw.model).toBe('fake');
  });

  it('matches scripts by case-insensitive substring; newest script wins', async () => {
    const fake = new FakeModel([{ match: 'budget', reply: { text: 'NOT_IN_DOCUMENT: no budget is given.' } }]);
    fake.script({
      match: 'owned',
      reply: (rq) => {
        const d = rq.documents.findIndex((x) => x.title === 'Decision');
        const s = rq.documents[d]!.blocks.findIndex((b) => b.startsWith('Mira Chen'));
        return { blocks: [{ text: 'Mira Chen owned it.', citations: [fakeCitation(rq, d, s)] }] };
      },
    });
    fake.script({ match: 'OWNED the limited', reply: { text: 'newer' } });

    const notFound = resolveCitations(await fake.generate(req('What was the BUDGET?'), () => {}, live()), req('x').documents, SAMPLE);
    expect(notFound).toMatchObject({ answerable: false, text: NOT_FOUND_MESSAGE, notFoundReason: 'not_in_document' });

    const r = req('Who owned the pilot?');
    const owned = resolveCitations(await fake.generate(r, () => {}, live()), r.documents, SAMPLE);
    expect(owned.citations[0]!.quote).toBe('Mira Chen owned the limited pilot.');

    const newer = await fake.generate(req('who owned the limited pilot'), () => {}, live());
    expect(newer.blocks[0]!.text).toBe('newer');
  });

  it('records every request in order', async () => {
    const fake = new FakeModel();
    await fake.generate(req('first'), () => {}, live());
    await fake.generate(req('second'), () => {}, live());
    expect(fake.requests.map((r) => r.question)).toEqual(['first', 'second']);
    expect(fake.lastRequest?.question).toBe('second');
  });

  it('throws scripted errors per attempt, then answers', async () => {
    const e1 = Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers());
    const e2 = new Anthropic.APIConnectionError({ message: 'reset' });
    const fake = new FakeModel([{ match: 'flaky', errors: [e1, e2] }]);
    await expect(fake.generate(req('flaky one'), () => {}, live())).rejects.toBe(e1);
    await expect(fake.generate(req('flaky one'), () => {}, live())).rejects.toBe(e2);
    const raw = await fake.generate(req('flaky one'), () => {}, live());
    expect(raw.stopReason).toBe('end_turn');
    expect(classifyError(e1).retryable).toBe(true);
    // Unrelated questions are unaffected.
    await expect(fake.generate(req('other'), () => {}, live())).resolves.toBeDefined();
  });

  it('scripted refusal rejects with ModelRefusalError', async () => {
    const fake = new FakeModel([{ match: 'refuse', reply: { text: 'I cannot help with that.', stopReason: 'refusal' } }]);
    const err = await fake.generate(req('please refuse'), () => {}, live()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRefusalError);
  });

  it('latch streams half the text and waits for release()', async () => {
    const fake = new FakeModel([{ match: 'slow', reply: { text: 'abcdefghij' }, latch: true }]);
    const deltas: string[] = [];
    let done = false;
    const latched = fake.whenLatched();
    const pending = fake.generate(req('slow question'), (t) => deltas.push(t), live()).then((r) => {
      done = true;
      return r;
    });
    const seen = await latched;
    expect(seen.question).toBe('slow question');
    expect(deltas).toEqual(['abcde']);
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);

    fake.release('slow');
    const raw = await pending;
    expect(deltas).toEqual(['abcde', 'fghij']);
    expect(raw.blocks[0]!.text).toBe('abcdefghij');

    // Released latches stay open.
    await expect(fake.generate(req('slow again'), () => {}, live())).resolves.toBeDefined();
  });

  it('an abort while latched rejects', async () => {
    const fake = new FakeModel([{ match: 'hold', latch: true }]);
    const ac = new AbortController();
    const latched = fake.whenLatched();
    const pending = fake.generate(req('hold it'), () => {}, ac.signal).catch((e: unknown) => e);
    await latched;
    ac.abort(new Error('shutdown'));
    expect(await pending).toEqual(new Error('shutdown'));
  });
});
