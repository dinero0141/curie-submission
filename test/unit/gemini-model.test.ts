// GeminiModel through a stubbed `fetch` (no network, no API key). Response bodies are written from the ASSUMED
// generateContent shapes in docs/notes/gemini-notes.md, NOT recorded from the live API. What this proves: the
// request body we send, the mapping of the structured answer into the RawAnswer shape that resolveCitations
// verifies unchanged, and error/timeout classification. Whether the API accepts and answers this request stays
// unverified until `pnpm smoke` runs with a real key.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../../src/domain/chunking.js';
import { NOT_FOUND_MESSAGE, resolveCitations } from '../../src/domain/citations.js';
import { classifyError, GeminiApiError, GeminiConnectionError, ModelRefusalError, ModelTimeoutError } from '../../src/llm/errors.js';
import {
  GEMINI_RESPONSE_SCHEMA,
  GEMINI_SYSTEM_INSTRUCTION,
  GEMINI_THINKING_HEADROOM_TOKENS,
  GeminiModel,
  geminiToRawAnswer,
  REFUSAL_FINISH_REASONS,
  renderPassages,
  STRUCTURED_OUTPUT_HEADROOM_TOKENS,
  stopReasonOf,
  thinkingConfigFor,
  toGeminiRequest,
} from '../../src/llm/gemini.js';
import { buildRequest } from '../../src/llm/prompt.js';
import type { AnswerRequest } from '../../src/llm/types.js';

const SAMPLE = readFileSync(new URL('../../samples/harbor-archive.md', import.meta.url), 'utf8');
const KEY = 'test-key-not-real';
const MODEL = 'gemini-3.8-flash';

function requestFor(content: string, question: string, history: { q: string; a: string }[] = []): AnswerRequest {
  const passages = chunkDocument(content, 'markdown').map((p) => ({ id: `p${p.ordinal}`, ...p }));
  const messages = history.flatMap((t) => [
    { role: 'user' as const, content: t.q, status: 'completed' },
    { role: 'assistant' as const, content: t.a, status: 'completed' },
  ]);
  return buildRequest({ documentTitle: 'Harbor', content, passages, history: messages, question });
}

const sampleRequest = (question = 'How many of the 40 questions did keyword search answer?') => requestFor(SAMPLE, question);

/** Passage index and sentence number of the sentence starting with `prefix`. */
function locate(req: AnswerRequest, prefix: string): { passage: number; sentence: number; text: string } {
  for (const [passage, d] of req.documents.entries()) {
    const sentence = d.blocks.findIndex((b) => b.startsWith(prefix));
    if (sentence >= 0) return { passage, sentence, text: d.blocks[sentence]! };
  }
  throw new Error(`no sentence starts with ${prefix}`);
}

type Cite = { passage: unknown; firstSentence: unknown; lastSentence: unknown; quote?: unknown };
const answer = (segments: { text: string; citations: unknown[] }[], extra: Record<string, unknown> = {}) => ({
  notInDocument: false,
  segments,
  ...extra,
});

const USAGE = { promptTokenCount: 900, candidatesTokenCount: 60, thoughtsTokenCount: 30, totalTokenCount: 990 };

/** A 200 generateContent body with one candidate whose text is `text` (JSON-encoded unless a string). */
function body(text: unknown, finishReason = 'STOP', extra: Record<string, unknown> = {}) {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ text: typeof text === 'string' ? text : JSON.stringify(text) }] }, finishReason, index: 0 },
    ],
    usageMetadata: USAGE,
    modelVersion: 'gemini-3.8-flash-001',
    responseId: 'resp_t',
    ...extra,
  };
}

const json = (status: number, b: unknown) =>
  new Response(typeof b === 'string' ? b : JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; method: string | undefined; headers: Headers; body: Record<string, unknown> };

function stubFetch(respond: (call: Call, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) };
    calls.push(call);
    return respond(call, init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const model = (fetch: typeof globalThis.fetch, timeoutMs = 5_000, name = MODEL) =>
  new GeminiModel({ apiKey: KEY, model: name, maxAnswerTokens: 1024, timeoutMs, fetch, baseURL: 'http://stub.invalid/' });

const run = (fetch: typeof globalThis.fetch, req = sampleRequest()) => model(fetch).generate(req, () => {}, new AbortController().signal);
const fail = (fetch: typeof globalThis.fetch, req = sampleRequest()) => run(fetch, req).catch((e: unknown) => e);
const mapped = (b: unknown) => geminiToRawAnswer(b, MODEL);

describe('toGeminiRequest / GeminiModel request', () => {
  const TINY = '# T\n\nAlpha one. Beta\ntwo.\n\n## S "q"\n\nGamma three.\n';

  it('sends the exact generateContent body for a small request, key in the header only', async () => {
    const req = requestFor(TINY, 'What is gamma?', [{ q: 'What is alpha?', a: 'Alpha is one.' }]);
    const { fetch, calls } = stubFetch(() => json(200, body(answer([]))));
    await model(fetch).generate(req, () => {}, new AbortController().signal);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://stub.invalid/v1beta/models/gemini-3.8-flash:generateContent');
    expect(call.url).not.toContain(KEY);
    expect(call.method).toBe('POST');
    expect(call.headers.get('x-goog-api-key')).toBe(KEY);
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.body).toEqual({
      systemInstruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
      contents: [
        { role: 'user', parts: [{ text: 'What is alpha?' }] },
        { role: 'model', parts: [{ text: 'Alpha is one.' }] },
        {
          role: 'user',
          parts: [
            {
              text: [
                '<passage index="0" title="T">',
                '[0] Alpha one.',
                '[1] Beta two.', // the soft wrap inside the sentence is sent as a space
                '</passage>',
                '',
                '<passage index="1" title="S \\"q\\"">',
                '[0] Gamma three.',
                '</passage>',
                '',
                'The passages above are from the document "Harbor".',
                '',
                'Question: What is gamma?',
              ].join('\n'),
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 1024 + STRUCTURED_OUTPUT_HEADROOM_TOKENS + GEMINI_THINKING_HEADROOM_TOKENS,
        responseMimeType: 'application/json',
        responseJsonSchema: GEMINI_RESPONSE_SCHEMA,
        thinkingConfig: { thinkingLevel: 'low' },
      },
    });
    for (const k of ['temperature', 'topP', 'topK', 'responseSchema', 'candidateCount']) {
      expect(call.body.generationConfig).not.toHaveProperty(k);
    }
  });

  it('sends thinkingLevel only to Gemini 3+ model ids', () => {
    expect(thinkingConfigFor('gemini-3.8-flash')).toEqual({ thinkingLevel: 'low' });
    expect(thinkingConfigFor('gemini-3.5-flash-lite')).toEqual({ thinkingLevel: 'low' });
    expect(thinkingConfigFor('gemini-4-hydrogen')).toEqual({ thinkingLevel: 'low' });
    expect(thinkingConfigFor('gemini-2.5-flash-lite')).toBeUndefined();
    expect(thinkingConfigFor('gemma-3-27b-it')).toBeUndefined();
    const params = toGeminiRequest(sampleRequest(), { model: 'gemini-2.5-flash-lite', maxAnswerTokens: 10 });
    expect(params.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('numbers sentences with the block index and passages with the document index', () => {
    const req = sampleRequest();
    const text = renderPassages(req.documents);
    const { passage, sentence, text: sentenceText } = locate(req, 'Keyword search returned');
    const section = text.split('\n\n')[passage]!;
    expect(section.startsWith(`<passage index="${passage}" title="Results">`)).toBe(true);
    expect(section).toContain(`\n[${sentence}] ${sentenceText}\n`);
  });

  it('never calls onDelta (the JSON answer arrives whole)', async () => {
    const { fetch } = stubFetch(() => json(200, body(answer([{ text: 'x', citations: [] }]))));
    const deltas: string[] = [];
    await model(fetch).generate(sampleRequest(), (t) => deltas.push(t), new AbortController().signal);
    expect(deltas).toEqual([]);
  });
});

describe('geminiToRawAnswer mapping', () => {
  const c = (passage: unknown, firstSentence: unknown, lastSentence: unknown, quote: unknown = 'q'): Cite => ({ passage, firstSentence, lastSentence, quote });

  it('maps each segment to a block and each citation to content_block_location with an exclusive end', () => {
    const raw = mapped(
      body(
        answer([
          { text: 'Keyword search found 28 of 40', citations: [c(2, 0, 0, 'A.')] },
          { text: 'and the hybrid 34.', citations: [c(2, 1, 1, 'B.'), c(1, 1, 3, 'C.')] },
          { text: 'Uncited.', citations: [] },
        ]),
      ),
    );
    expect(raw.blocks).toEqual([
      { text: 'Keyword search found 28 of 40', citations: [{ type: 'content_block_location', document_index: 2, start_block_index: 0, end_block_index: 1, cited_text: 'A.' }] },
      {
        text: ' and the hybrid 34.', // a space is added between segments that have none
        citations: [
          { type: 'content_block_location', document_index: 2, start_block_index: 1, end_block_index: 2, cited_text: 'B.' },
          { type: 'content_block_location', document_index: 1, start_block_index: 1, end_block_index: 4, cited_text: 'C.' },
        ],
      },
      { text: ' Uncited.', citations: null },
    ]);
    expect(raw).toMatchObject({ stopReason: 'end_turn', usage: USAGE, model: 'gemini-3.8-flash-001' });
  });

  it('adds no space before closing punctuation or where a segment already has whitespace', () => {
    const raw = mapped(body(answer([{ text: 'A', citations: [] }, { text: '.', citations: [] }, { text: ' B', citations: [] }, { text: 'C ', citations: [] }, { text: 'D', citations: [] }])));
    expect(raw.blocks.map((b) => b.text).join('')).toBe('A. B C D');
  });

  it('notInDocument without segments → one marker block with the reason', () => {
    const raw = mapped(body({ notInDocument: true, reason: 'The budget is not stated.', segments: [] }));
    expect(raw.blocks).toEqual([{ text: 'NOT_IN_DOCUMENT: The budget is not stated.', citations: null }]);
    const noReason = mapped(body({ notInDocument: true, segments: [] }));
    expect(noReason.blocks).toEqual([{ text: 'NOT_IN_DOCUMENT:', citations: null }]);
  });

  it('notInDocument with segments → marker block first, then the segments', () => {
    const raw = mapped(body({ notInDocument: true, reason: 'Partly.', segments: [{ text: 'X.', citations: [c(0, 0, 0)] }] }));
    expect(raw.blocks.map((b) => b.text)).toEqual(['NOT_IN_DOCUMENT: Partly.', ' X.']);
    expect(raw.blocks[0]!.citations).toBeNull();
    expect(raw.blocks[1]!.citations).toHaveLength(1);
  });

  it('passes citation values through untouched (no clamping or repair)', () => {
    const raw = mapped(body(answer([{ text: 'x', citations: [c(1.5, -1, 'two', 7), 'not an object', { passage: 0 }] }])));
    expect(raw.blocks[0]!.citations).toEqual([
      { type: 'content_block_location', document_index: 1.5, start_block_index: -1, end_block_index: 'two', cited_text: 7 },
      'not an object',
      { type: 'content_block_location', document_index: 0, start_block_index: undefined, end_block_index: undefined, cited_text: undefined },
    ]);
  });

  it('skips thought parts and joins the other text parts', () => {
    const text = JSON.stringify(answer([{ text: 'Hi.', citations: [] }]));
    const raw = mapped({
      candidates: [{ content: { parts: [{ text: 'thinking about it', thought: true }, { text: text.slice(0, 10) }, { text: text.slice(10), thoughtSignature: 'sig' }] }, finishReason: 'STOP' }],
    });
    expect(raw.blocks).toEqual([{ text: 'Hi.', citations: null }]);
    expect(raw.model).toBe(MODEL); // no modelVersion → the configured model
    expect(raw.usage).toBeNull();
  });

  it('maps finish reasons: STOP → end_turn, MAX_TOKENS and CONTINUATION → max_tokens, others lower-cased', () => {
    expect(stopReasonOf('STOP')).toBe('end_turn');
    expect(stopReasonOf('MAX_TOKENS')).toBe('max_tokens');
    expect(stopReasonOf('CONTINUATION')).toBe('max_tokens');
    expect(stopReasonOf('MALFORMED_RESPONSE')).toBe('malformed_response');
    expect(mapped(body(answer([]), 'OTHER')).stopReason).toBe('other');
  });
});

describe('GeminiModel answers through resolveCitations (real chunker output)', () => {
  const KEYWORD = 'Keyword search returned';

  async function resolvedFor(cites: (req: AnswerRequest) => unknown[], finishReason = 'STOP') {
    const req = sampleRequest();
    const { fetch } = stubFetch(() => json(200, body(answer([{ text: 'Keyword search answered 28 of the 40 questions.', citations: cites(req) }]), finishReason)));
    const raw = await run(fetch, req);
    return { req, raw, resolved: resolveCitations(raw, req.documents, SAMPLE) };
  }

  it('verifies a correct quote; offsets slice the content to the quote', async () => {
    const { resolved } = await resolvedFor((req) => {
      const k = locate(req, KEYWORD);
      return [{ passage: k.passage, firstSentence: k.sentence, lastSentence: k.sentence, quote: k.text }];
    });
    expect(resolved).toMatchObject({ answerable: true, notFoundReason: null, dropped: [] });
    expect(resolved.citations).toHaveLength(1);
    const cit = resolved.citations[0]!;
    expect(cit.quote).toBe('Keyword search returned a relevant passage for 28 of the 40 questions.');
    expect(SAMPLE.slice(cit.startOffset, cit.endOffset)).toBe(cit.quote);
    expect(cit.heading).toBe('Results');
  });

  it('verifies an inclusive multi-sentence range as one contiguous slice', async () => {
    const { resolved } = await resolvedFor((req) => {
      const k = locate(req, KEYWORD);
      const doc = req.documents[k.passage]!;
      return [{ passage: k.passage, firstSentence: k.sentence, lastSentence: k.sentence + 1, quote: `${doc.blocks[k.sentence]}\n\n${doc.blocks[k.sentence + 1]}` }];
    });
    expect(resolved.citations).toHaveLength(1);
    const cit = resolved.citations[0]!;
    expect(cit.quote).toBe(SAMPLE.slice(cit.startOffset, cit.endOffset));
    expect(cit.quote).toContain('28 of the 40');
    expect(cit.quote).toContain('34 of the 40');
  });

  it('drops a quote that does not match the cited sentence (wrong sentence id) as cited_text_mismatch', async () => {
    const { resolved } = await resolvedFor((req) => {
      const k = locate(req, KEYWORD);
      return [{ passage: k.passage, firstSentence: k.sentence + 1, lastSentence: k.sentence + 1, quote: k.text }];
    });
    expect(resolved).toMatchObject({ answerable: false, notFoundReason: 'unverified' });
    expect(resolved.dropped.map((d) => d.reason)).toEqual(['cited_text_mismatch']);
  });

  it.each([
    ['passage out of range', { passage: 99, firstSentence: 0, lastSentence: 0 }, 'document_out_of_range'],
    ['negative passage', { passage: -1, firstSentence: 0, lastSentence: 0 }, 'document_out_of_range'],
    ['non-integer passage', { passage: 2.5, firstSentence: 0, lastSentence: 0 }, 'document_out_of_range'],
    ['sentence out of range', { passage: 2, firstSentence: 0, lastSentence: 99 }, 'block_out_of_range'],
    ['non-integer sentence', { passage: 2, firstSentence: 0.5, lastSentence: 0.5 }, 'block_out_of_range'],
    ['last before first', { passage: 2, firstSentence: 2, lastSentence: 1 }, 'block_out_of_range'],
    ['string sentence', { passage: 2, firstSentence: '0', lastSentence: '0' }, 'block_out_of_range'],
  ])('drops a citation with %s', async (_name, cite, reason) => {
    const { resolved } = await resolvedFor(() => [{ ...cite, quote: 'whatever' }]);
    expect(resolved.notFoundReason).toBe('unverified');
    expect(resolved.dropped.map((d) => d.reason)).toEqual([reason]);
  });

  it('drops a citation without a quote (cited_text_missing) and a non-object citation (malformed)', async () => {
    const { resolved } = await resolvedFor((req) => {
      const k = locate(req, KEYWORD);
      return [{ passage: k.passage, firstSentence: k.sentence, lastSentence: k.sentence }, 42];
    });
    expect(resolved.dropped.map((d) => d.reason)).toEqual(['cited_text_missing', 'malformed']);
  });

  it('notInDocument → not_in_document with the fixed not-found text', async () => {
    const req = sampleRequest("What was the pilot's budget?");
    const { fetch } = stubFetch(() => json(200, body({ notInDocument: true, reason: 'No budget is given.', segments: [] })));
    const resolved = resolveCitations(await run(fetch, req), req.documents, SAMPLE);
    expect(resolved).toMatchObject({ answerable: false, notFoundReason: 'not_in_document', text: NOT_FOUND_MESSAGE, citations: [] });
    expect(resolved.rawText).toBe('NOT_IN_DOCUMENT: No budget is given.');
  });

  it('MAX_TOKENS with truncated JSON → truncated', async () => {
    const { fetch } = stubFetch(() => json(200, body('{"notInDocument": false, "segments": [{"text": "Keyword sea', 'MAX_TOKENS')));
    const raw = await run(fetch);
    expect(raw).toMatchObject({ blocks: [], stopReason: 'max_tokens' });
    expect(resolveCitations(raw, sampleRequest().documents, SAMPLE).notFoundReason).toBe('truncated');
  });

  it('MAX_TOKENS with an empty reply (thinking used the budget) → truncated', async () => {
    const { fetch } = stubFetch(() => json(200, { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }], usageMetadata: USAGE }));
    const raw = await run(fetch);
    expect(resolveCitations(raw, sampleRequest().documents, SAMPLE).notFoundReason).toBe('truncated');
  });

  it.each([
    ['invalid JSON', 'Keyword search answered 28 of the 40 questions.'],
    ['JSON of the wrong shape', JSON.stringify({ answer: 'Keyword search answered 28.' })],
    ['segments not an array', JSON.stringify({ notInDocument: false, segments: 'x' })],
  ])('STOP with %s → one raw uncited block → unverified', async (_name, text) => {
    const { fetch } = stubFetch(() => json(200, body(text)));
    const raw = await run(fetch);
    expect(raw.blocks).toEqual([{ text, citations: null }]);
    expect(resolveCitations(raw, sampleRequest().documents, SAMPLE).notFoundReason).toBe('unverified');
  });

  it('no candidates and no block reason → no_candidates, unverified', async () => {
    const { fetch } = stubFetch(() => json(200, { usageMetadata: { promptTokenCount: 900 }, modelVersion: 'gemini-3.8-flash-001' }));
    const raw = await run(fetch);
    expect(raw).toMatchObject({ blocks: [], stopReason: 'no_candidates', model: 'gemini-3.8-flash-001' });
    expect(resolveCitations(raw, sampleRequest().documents, SAMPLE).notFoundReason).toBe('unverified');
  });
});

describe('GeminiModel refusals and errors', () => {
  it.each([...REFUSAL_FINISH_REASONS])('finishReason %s → ModelRefusalError → model_refused', async (reason) => {
    const { fetch } = stubFetch(() => json(200, body('', reason)));
    const err = await fail(fetch);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect((err as ModelRefusalError).category).toBe(reason.toLowerCase());
    expect(classifyError(err)).toMatchObject({ code: 'model_refused', retryable: false });
  });

  it('a blocked prompt (promptFeedback.blockReason, no candidates) → model_refused', async () => {
    const { fetch } = stubFetch(() => json(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 900 } }));
    const err = await fail(fetch);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect((err as ModelRefusalError).category).toBe('prompt_blocked:PROHIBITED_CONTENT');
    expect(classifyError(err)).toMatchObject({ code: 'model_refused', retryable: false });
  });

  const apiBody = (code: number, status: string, message: string) => ({ error: { code, message, status } });

  it.each([
    [429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).', 'model_unavailable', true],
    [503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.', 'model_unavailable', true],
    [500, 'INTERNAL', 'An internal error has occurred.', 'model_unavailable', true],
    [504, 'DEADLINE_EXCEEDED', 'Deadline exceeded.', 'model_unavailable', true],
    [400, 'INVALID_ARGUMENT', 'The input token count (135538) exceeds the maximum number of tokens allowed (131072).', 'context_too_large', false],
    [400, 'INVALID_ARGUMENT', 'Unable to submit request because the input token count is 40000 but model only supports up to 32768', 'context_too_large', false],
    [400, 'INVALID_ARGUMENT', 'Invalid JSON payload received. Unknown name "foo".', 'model_config_error', false],
    [400, 'FAILED_PRECONDITION', 'Gemini API free tier is not available in your country. Please enable billing.', 'model_config_error', false],
    [401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.', 'model_config_error', false],
    [402, 'RESOURCE_EXHAUSTED', 'Prepay credits depleted.', 'model_config_error', false],
    [403, 'PERMISSION_DENIED', 'Your API key was reported as leaked.', 'model_config_error', false],
    [404, 'NOT_FOUND', 'models/gemini-9 is not found for API version v1beta.', 'model_config_error', false],
  ])('HTTP %i %s → %s', async (status, apiStatus, message, code, retryable) => {
    const { fetch, calls } = stubFetch(() => json(status, apiBody(status, apiStatus, message)));
    const err = await fail(fetch);
    expect(err).toBeInstanceOf(GeminiApiError);
    expect(err).toMatchObject({ httpStatus: status, apiStatus });
    expect((err as Error).message).toContain(message);
    expect((err as Error).message).not.toContain(KEY);
    expect(classifyError(err)).toMatchObject({ code, retryable });
    expect(calls).toHaveLength(1); // no retry inside the adapter: BullMQ owns retries
  });

  it('an error response that is not the JSON envelope still classifies by status', async () => {
    const { fetch } = stubFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const err = await fail(fetch);
    expect(err).toMatchObject({ httpStatus: 502, apiStatus: null });
    expect(classifyError(err)).toMatchObject({ code: 'model_unavailable', retryable: true });
  });

  it('a 200 whose body is not JSON → retryable model_unavailable', async () => {
    const { fetch } = stubFetch(() => new Response('<html>proxy</html>', { status: 200 }));
    const err = await fail(fetch);
    expect(err).toBeInstanceOf(GeminiConnectionError);
    expect(classifyError(err)).toMatchObject({ code: 'model_unavailable', retryable: true });
  });

  it('a rejected fetch (network) → GeminiConnectionError → model_unavailable', async () => {
    const { fetch } = stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const err = await fail(fetch);
    expect(err).toBeInstanceOf(GeminiConnectionError);
    expect((err as Error).message).toContain('fetch failed');
    expect(classifyError(err)).toMatchObject({ code: 'model_unavailable', retryable: true });
  });

  const hang = (_call: Call, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

  it('enforces MODEL_TIMEOUT_MS (→ ModelTimeoutError, retryable)', async () => {
    const { fetch } = stubFetch(hang);
    const err = await model(fetch, 100).generate(sampleRequest(), () => {}, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelTimeoutError);
    expect(classifyError(err)).toMatchObject({ code: 'model_unavailable', retryable: true });
  });

  it('a caller abort is not reported as our timeout (→ model_unavailable, retryable)', async () => {
    const { fetch } = stubFetch(hang);
    const ac = new AbortController();
    const pending = model(fetch).generate(sampleRequest(), () => {}, ac.signal).catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 20);
    const err = await pending;
    expect(err).not.toBeInstanceOf(ModelTimeoutError);
    expect(err).toBeInstanceOf(GeminiConnectionError);
    expect(classifyError(err)).toMatchObject({ code: 'model_unavailable', retryable: true });
  });

  it('a timeout while reading the body is our timeout too', async () => {
    const { fetch } = stubFetch((_call, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"candidates": ['));
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { status: 200 });
    });
    const err = await model(fetch, 100).generate(sampleRequest(), () => {}, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelTimeoutError);
  });
});
