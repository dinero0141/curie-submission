// AnthropicModel through the real SDK client with a stubbed `fetch` (no network, no API key). The SSE events
// below are written from the ASSUMED shapes in docs/notes/citations-spike.md (claude-api skill + SDK 1.10.0
// types), NOT recorded from the live API. What this proves: our adapter + the installed SDK's MessageStream
// fold such events into the RawAnswer resolveCitations expects, errors surface as SDK classes, and our
// timeout/retry settings hold. Whether the API really emits these events stays unverified until `pnpm spike`.
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../../src/domain/chunking.js';
import { resolveCitations } from '../../src/domain/citations.js';
import { AnthropicModel, THINKING_HEADROOM_TOKENS, toRawAnswer } from '../../src/llm/anthropic.js';
import { classifyError, ModelRefusalError, ModelTimeoutError } from '../../src/llm/errors.js';
import { buildRequest } from '../../src/llm/prompt.js';

const SAMPLE = readFileSync(new URL('../../samples/harbor-archive.md', import.meta.url), 'utf8');

function sampleRequest(question = 'Who owned the limited pilot?') {
  const passages = chunkDocument(SAMPLE, 'markdown').map((p) => ({ id: `p${p.ordinal}`, ...p }));
  return buildRequest({ documentTitle: 'Harbor', content: SAMPLE, passages, history: [], question });
}

const sse = (events: object[]) =>
  events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function sseResponse(events: object[]): Response {
  return new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_t' } });
}

type Call = { url: string; body: Record<string, unknown>; headers: Headers };

function stubFetch(respond: (call: Call, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: JSON.parse(String(init?.body ?? '{}')), headers: new Headers(init?.headers) };
    calls.push(call);
    return respond(call, init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const model = (fetch: typeof globalThis.fetch, timeoutMs = 5_000) =>
  new AnthropicModel({ apiKey: 'test-key-not-real', model: 'claude-sonnet-5-5', maxAnswerTokens: 1024, timeoutMs, fetch, baseURL: 'http://stub.invalid' });

/** A streamed answer: an empty thinking block (display omitted), an uncited lead-in, then a cited block. */
function answerEvents(req: ReturnType<typeof sampleRequest>, docIndex: number, start: number, stopReason = 'end_turn') {
  const doc = req.documents[docIndex]!;
  return [
    { type: 'message_start', message: { id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage: { input_tokens: 900, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'According to the note, ' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '', citations: null } },
    {
      type: 'content_block_delta',
      index: 2,
      delta: {
        type: 'citations_delta',
        citation: { type: 'content_block_location', cited_text: doc.blocks[start], document_index: docIndex, document_title: doc.title, start_block_index: start, end_block_index: start + 1, file_id: null },
      },
    },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Mira Chen owned ' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'the limited pilot.' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ];
}

describe('AnthropicModel (stubbed fetch, assumed event shapes)', () => {
  it('streams text deltas, folds citations into the final message, and the result verifies', async () => {
    const req = sampleRequest();
    const docIndex = req.documents.findIndex((d) => d.title === 'Decision');
    const start = req.documents[docIndex]!.blocks.findIndex((b) => b.startsWith('Mira Chen'));
    const { fetch, calls } = stubFetch(() => sseResponse(answerEvents(req, docIndex, start)));

    const deltas: string[] = [];
    const raw = await model(fetch).generate(req, (t) => deltas.push(t), new AbortController().signal);

    expect(deltas.join('')).toBe('According to the note, Mira Chen owned the limited pilot.');
    expect(raw.blocks.map((b) => b.text)).toEqual(['According to the note, ', 'Mira Chen owned the limited pilot.']); // thinking skipped
    expect(raw.blocks[0]!.citations).toBeNull();
    expect(raw.blocks[1]!.citations).toHaveLength(1);
    expect(raw.stopReason).toBe('end_turn');
    expect(raw.model).toBe('claude-sonnet-5-5');
    expect(raw.usage).toMatchObject({ input_tokens: 900, output_tokens: 40 });

    const resolved = resolveCitations(raw, req.documents, SAMPLE);
    expect(resolved.answerable).toBe(true);
    expect(resolved.citations).toHaveLength(1);
    const c = resolved.citations[0]!;
    expect(SAMPLE.slice(c.startOffset, c.endOffset)).toBe(c.quote);
    expect(c.quote).toBe('Mira Chen owned the limited pilot.');
    expect(c.heading).toBe('Decision');

    // One HTTP call (maxRetries 0), streaming body as built by toAnthropicParams.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://stub.invalid/v1/messages');
    expect(calls[0]!.body).toMatchObject({ model: 'claude-sonnet-5-5', stream: true, max_tokens: 1024 + THINKING_HEADROOM_TOKENS });
    expect(calls[0]!.body).not.toHaveProperty('temperature');
    expect(calls[0]!.body).not.toHaveProperty('thinking');
  });

  it('turns stop_reason refusal into ModelRefusalError (→ model_refused)', async () => {
    const req = sampleRequest();
    const events = answerEvents(req, 0, 0, 'refusal').map((e) =>
      e.type === 'message_delta' ? { ...e, delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'cyber', explanation: null } } } : e,
    );
    const { fetch } = stubFetch(() => sseResponse(events));
    const err = await model(fetch).generate(req, () => {}, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect((err as ModelRefusalError).category).toBe('cyber');
    expect(classifyError(err).code).toBe('model_refused');
  });

  it('surfaces HTTP errors as SDK classes and does not retry them itself', async () => {
    const { fetch, calls } = stubFetch(
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
          status: 529,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const err = await model(fetch).generate(sampleRequest(), () => {}, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.OverloadedError);
    expect(classifyError(err)).toMatchObject({ code: 'model_unavailable', retryable: true });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['overloaded_error', 'Overloaded', { code: 'model_unavailable', retryable: true }],
    ['invalid_request_error', 'messages: something is wrong', { code: 'model_config_error', retryable: false }],
    ['invalid_request_error', 'prompt is too long: 1234567 tokens > 1000000 maximum', { code: 'context_too_large', retryable: false }],
  ])('classifies a mid-stream `event: error` (%s) as the SDK raises it, after earlier deltas', async (type, message, expected) => {
    const req = sampleRequest();
    const head = answerEvents(req, 0, 0).slice(0, 6); // message_start .. first text delta
    const events = sse(head) + `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`;
    const { fetch } = stubFetch(
      () => new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const deltas: string[] = [];
    const err = await model(fetch).generate(req, (t) => deltas.push(t), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIError);
    expect((err as InstanceType<typeof Anthropic.APIError>).status).toBeUndefined();
    expect(classifyError(err)).toMatchObject(expected);
    expect(deltas.join('')).toBe('According to the note, ');
  });

  it('maps a 401 to a permanent model_config_error', async () => {
    const { fetch } = stubFetch(
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const err = await model(fetch).generate(sampleRequest(), () => {}, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.AuthenticationError);
    expect(classifyError(err)).toMatchObject({ code: 'model_config_error', retryable: false });
  });

  it('enforces MODEL_TIMEOUT_MS over the whole stream (→ ModelTimeoutError, retryable)', async () => {
    const req = sampleRequest();
    const head = answerEvents(req, 0, 0).slice(0, 6); // message_start .. first text delta, then the stream stalls
    const { fetch } = stubFetch((_call, init) => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(sse(head)));
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const deltas: string[] = [];
    const err = await model(fetch, 150).generate(req, (t) => deltas.push(t), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelTimeoutError);
    expect(classifyError(err)).toMatchObject({ code: 'model_unavailable', retryable: true });
    expect(deltas.join('')).toBe('According to the note, ');
  });

  it('a caller abort is not reported as our timeout', async () => {
    const { fetch } = stubFetch(
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const ac = new AbortController();
    const pending = model(fetch).generate(sampleRequest(), () => {}, ac.signal).catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 20);
    const err = await pending;
    expect(err).not.toBeInstanceOf(ModelTimeoutError);
    expect(err).toBeInstanceOf(Anthropic.APIUserAbortError);
  });
});

describe('toRawAnswer', () => {
  it('keeps text blocks in order, skips other block types, defaults a missing stop_reason', () => {
    const message = {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [
        { type: 'thinking', thinking: '', signature: 's' },
        { type: 'text', text: 'A', citations: null },
        { type: 'text', text: 'B', citations: [{ type: 'content_block_location' }] },
      ],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    } as unknown as Anthropic.Message;
    const raw = toRawAnswer(message);
    expect(raw.blocks).toEqual([
      { text: 'A', citations: null },
      { text: 'B', citations: [{ type: 'content_block_location' }] },
    ]);
    expect(raw.stopReason).toBe('unknown');
  });
});
