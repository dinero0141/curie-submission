// The generate-answer processor with the real GeminiModel over a stubbed `fetch` (no network, no API key), against
// real Postgres. The stub answers from the rendered prompt the way the structured-output contract asks (passage
// index + sentence numbers + copied quote); the response shape is ASSUMED (docs/notes/gemini-notes.md, UNVERIFIED).
// What this proves: a Gemini answer goes through the same resolveCitations verification and processor outcomes as a
// Claude one: a correct reply completes with quotes equal to content.slice, a reply whose quotes are all wrong fails
// as citations_unverified.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertConversation } from '../../src/db/conversations.js';
import { insertDocument } from '../../src/db/documents.js';
import { getMessage, insertMessage } from '../../src/db/messages.js';
import type { Citation } from '../../src/domain/citations.js';
import { createGenerateAnswerProcessor } from '../../src/jobs/generateAnswer.js';
import { createPrepareDocumentProcessor } from '../../src/jobs/prepareDocument.js';
import { closeQueues, createQueues, createRedisConnection, enqueueGenerateAnswer, RETRY_AFTER_BACKOFF } from '../../src/jobs/queues.js';
import { createGenerateAnswerWorker } from '../../src/jobs/generateAnswer.js';
import { GeminiModel } from '../../src/llm/gemini.js';
import { useIntegrationEnv } from './setup.js';

const env = useIntegrationEnv();
const SAMPLE = readFileSync(fileURLToPath(new URL('../../samples/harbor-archive.md', import.meta.url)), 'utf8');

/** The sentence's `[passage, sentence, text]` in the prompt, found by scanning the rendered passages. */
function findSentence(prompt: string, prefix: string): { passage: number; sentence: number; text: string } {
  let passage = -1;
  for (const line of prompt.split('\n')) {
    const open = /^<passage index="(\d+)"/.exec(line);
    if (open) passage = Number(open[1]);
    const numbered = /^\[(\d+)\] (.*)$/.exec(line);
    if (numbered && passage >= 0 && numbered[2]!.startsWith(prefix)) {
      return { passage, sentence: Number(numbered[1]), text: numbered[2]! };
    }
  }
  throw new Error(`sentence "${prefix}" not in the prompt`);
}

type Body = { contents: { role: string; parts: { text: string }[] }[] };

/**
 * A Gemini stub that cites the sentence starting with `prefix`; `quote` overrides the copied text. `before[i]`,
 * when set, is returned for call `i` instead (e.g. a 429).
 */
function geminiStub(prefix: string, quote?: string, before: (() => Response)[] = []) {
  const calls: Body[] = [];
  const callTimes: number[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push(body);
    callTimes.push(Date.now());
    const early = before[calls.length - 1];
    if (early) return early();
    const prompt = body.contents.at(-1)!.parts[0]!.text;
    const s = findSentence(prompt, prefix);
    const answer = {
      notInDocument: false,
      segments: [
        { text: 'Keyword search answered', citations: [] },
        { text: '28 of the 40 questions.', citations: [{ passage: s.passage, firstSentence: s.sentence, lastSentence: s.sentence, quote: quote ?? s.text }] },
      ],
    };
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 80, totalTokenCount: 780 },
        modelVersion: 'gemini-3.8-flash-001',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  const model = new GeminiModel({ apiKey: 'test-key-not-real', model: 'gemini-3.8-flash', maxAnswerTokens: 1024, timeoutMs: 5_000, fetch, baseURL: 'http://stub.invalid' });
  return { model, calls, callTimes };
}

let docId: string;

beforeAll(async () => {
  const doc = await insertDocument(env.pool, { title: 'Harbor Archive', format: 'markdown', content: SAMPLE });
  const prepare = createPrepareDocumentProcessor({ pool: env.pool, passageTokens: 400 });
  await prepare({ id: doc.id, data: { documentId: doc.id }, attemptsMade: 0, opts: { attempts: 1 } });
  docId = doc.id;
});

async function answer(model: GeminiModel, question: string) {
  const conversation = await insertConversation(env.pool, docId);
  await insertMessage(env.pool, { conversationId: conversation.id, role: 'user', content: question });
  const assistant = await insertMessage(env.pool, { conversationId: conversation.id, role: 'assistant' });
  const processor = createGenerateAnswerProcessor({ pool: env.pool, model, fullContextTokens: 60_000, partialWriteMs: 10 });
  const outcome = await processor({ id: assistant.id, data: { messageId: assistant.id }, attemptsMade: 0, opts: { attempts: 3 } }).catch(
    (e: unknown) => e,
  );
  return { outcome, row: (await getMessage(env.pool, assistant.id))! };
}

describe('generate-answer with GeminiModel (stubbed fetch)', () => {
  it('completes with a verified quote equal to content.slice(startOffset, endOffset)', async () => {
    const { model, calls } = geminiStub('Keyword search returned');
    const { outcome, row } = await answer(model, 'How many of the 40 questions did keyword search answer?');

    expect(outcome).toEqual({ outcome: 'completed', answerable: true, citations: 1 });
    expect(row).toMatchObject({
      status: 'completed',
      answerable: true,
      content: 'Keyword search answered 28 of the 40 questions.',
      finishReason: 'end_turn',
      model: 'gemini-3.8-flash-001',
      usage: { totalTokenCount: 780 },
    });
    const citations = row.citations as Citation[];
    expect(citations).toHaveLength(1);
    const c = citations[0]!;
    expect(c.quote).toBe(SAMPLE.slice(c.startOffset, c.endOffset));
    expect(c.quote).toBe('Keyword search returned a relevant passage for 28 of the 40 questions.');
    expect(c.heading).toBe('Results');
    // The answer text range of the quote is the cited segment (after the added space).
    expect(row.content.slice(c.answerStart, c.answerEnd)).toBe(' 28 of the 40 questions.');
    expect(calls).toHaveLength(1);
  });

  it('fails permanently with citations_unverified when every quote is wrong', async () => {
    // Cites the right sentence id with another sentence's text (the model pointing at the wrong sentence).
    const { model } = geminiStub('Keyword search returned', 'The hybrid prototype returned a relevant passage for 34 of the 40 questions.');
    const { outcome, row } = await answer(model, 'How many of the 40 questions did keyword search answer?');

    expect(outcome).toBeInstanceOf(UnrecoverableError);
    expect(row).toMatchObject({ status: 'failed', content: '', errorCode: 'citations_unverified', attempts: 1 });
    expect(row.citations).toBeNull();
  });
});

describe('generate-answer worker: a Gemini 429 waits its RetryInfo.retryDelay', () => {
  const redis = createRedisConnection(env.redisUrl);
  // The production backoff type with a tiny base delay: only the 429's retryDelay can make the wait long.
  const queues = createQueues(redis, { prefix: env.bullPrefix, generateAnswer: { backoff: { type: RETRY_AFTER_BACKOFF, delay: 1 } } });

  afterAll(async () => {
    await closeQueues(queues);
    await redis.quit();
  });

  it('retries after at least the retryDelay, then completes', async () => {
    const RETRY_DELAY_MS = 700;
    const tooMany = () =>
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'You exceeded your current quota.',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${RETRY_DELAY_MS / 1000}s` }],
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    const { model, callTimes } = geminiStub('Keyword search returned', undefined, [tooMany]);
    const worker = createGenerateAnswerWorker(redis, { pool: env.pool, model, fullContextTokens: 60_000, partialWriteMs: 10 }, { prefix: env.bullPrefix });
    try {
      await worker.waitUntilReady();
      const conversation = await insertConversation(env.pool, docId);
      await insertMessage(env.pool, { conversationId: conversation.id, role: 'user', content: 'How many of the 40 questions did keyword search answer?' });
      const assistant = await insertMessage(env.pool, { conversationId: conversation.id, role: 'assistant' });
      await enqueueGenerateAnswer(queues.generateAnswer, assistant.id);

      const deadline = Date.now() + 10_000;
      let row = (await getMessage(env.pool, assistant.id))!;
      while (row.status !== 'completed' && row.status !== 'failed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        row = (await getMessage(env.pool, assistant.id))!;
      }
      expect(row).toMatchObject({ status: 'completed', answerable: true, attempts: 2 });
      expect(callTimes).toHaveLength(2);
      // The 1 ms exponential base alone would retry almost at once.
      expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(RETRY_DELAY_MS - 50);
    } finally {
      await worker.close();
    }
  });
});
