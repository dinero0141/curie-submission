// Conversations + generate-answer end to end over HTTP (fastify.inject) with real Postgres/Redis/BullMQ workers
// and the scripted FakeModel. Citation shapes are the assumed ones from docs/notes/citations-spike.md
// (not observed live — keyless run); every quote still goes through resolveCitations.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { insertDocument } from '../../src/db/documents.js';
import { NOT_FOUND_MESSAGE } from '../../src/domain/citations.js';
import { buildApp } from '../../src/http/app.js';
import { MAX_QUESTION_LENGTH } from '../../src/http/routes/conversations.js';
import { createGenerateAnswerWorker } from '../../src/jobs/generateAnswer.js';
import { createPrepareDocumentWorker } from '../../src/jobs/prepareDocument.js';
import { closeQueues, createQueues, createRedisConnection, type Queues } from '../../src/jobs/queues.js';
import { createReconciler } from '../../src/jobs/reconciler.js';
import { FakeModel, fakeCitation } from '../../src/llm/fake.js';
import type { AnswerRequest } from '../../src/llm/types.js';
import { useIntegrationEnv } from './setup.js';

const env = useIntegrationEnv();
const SAMPLE = readFileSync(fileURLToPath(new URL('../../samples/harbor-archive.md', import.meta.url)), 'utf8');

let redis: Redis;
let queues: Queues;
let workers: Worker[];
let app: FastifyInstance;
const fake = new FakeModel();
let docId: string;

/** Cite the sentence block that contains `needle` (searching every sent passage). */
function citeSentence(req: AnswerRequest, needle: string) {
  for (let d = 0; d < req.documents.length; d++) {
    const b = req.documents[d]!.blocks.findIndex((x) => x.includes(needle));
    if (b >= 0) return fakeCitation(req, d, b);
  }
  throw new Error(`no sent block contains ${JSON.stringify(needle)}`);
}

fake.script({
  match: 'hybrid prototype get right',
  reply: (req) => ({
    blocks: [
      { text: 'The hybrid prototype found a relevant passage for 34 of the 40 questions.', citations: [citeSentence(req, '34 of the 40')] },
    ],
  }),
});
fake.script({
  match: 'and keyword search',
  reply: (req) => ({
    blocks: [
      { text: 'Keyword search managed 28 of the 40.', citations: [citeSentence(req, '28 of the 40')] },
      { text: ' Its median response time was 0.7 seconds.', citations: [citeSentence(req, 'Median response time')] },
    ],
  }),
});
fake.script({ match: 'who funded', reply: { text: 'NOT_IN_DOCUMENT: the document does not mention funding.' } });
fake.script({ match: 'uncited', reply: { text: 'Probably around forty questions.' } });
fake.script({ match: 'latched question', latch: true });
fake.script({ match: 'concurrent question', latch: true });
fake.script({
  match: 'bad key',
  errors: [Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, undefined, new Headers())],
});

beforeAll(async () => {
  const config = loadConfig({ MODEL_PROVIDER: 'fake', DATABASE_URL: env.databaseUrl, REDIS_URL: env.redisUrl });
  redis = createRedisConnection(env.redisUrl);
  queues = createQueues(redis, {
    prefix: env.bullPrefix,
    prepareDocument: { backoff: { type: 'fixed', delay: 20 } },
    generateAnswer: { backoff: { type: 'fixed', delay: 20 } },
  });
  app = buildApp({ pool: env.pool, config, queues });
  workers = [
    createPrepareDocumentWorker(redis, { pool: env.pool, passageTokens: config.passageTokens }, { prefix: env.bullPrefix }),
    createGenerateAnswerWorker(
      redis,
      { pool: env.pool, model: fake, fullContextTokens: config.fullContextTokens, partialWriteMs: 20 },
      { prefix: env.bullPrefix },
    ),
  ];
  await Promise.all(workers.map((w) => w.waitUntilReady()));

  const res = await app.inject({
    method: 'POST',
    url: '/documents',
    payload: { title: 'Harbor Archive', format: 'markdown', content: SAMPLE },
  });
  docId = res.json().id;
  await poll(`/documents/${docId}`, (b) => b.status === 'ready');
});

afterAll(async () => {
  fake.release();
  await Promise.all((workers ?? []).map((w) => w.close()));
  await app?.close();
  if (queues) await closeQueues(queues);
  await redis?.quit();
});

type Body = Record<string, any>;

async function poll(url: string, done: (body: Body) => boolean, timeoutMs = 10_000): Promise<Body> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await app.inject({ method: 'GET', url })).json() as Body;
    if (done(body)) return body;
    if (Date.now() > deadline) throw new Error(`${url} not done after ${timeoutMs} ms: ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const terminal = (b: Body) => b.status === 'completed' || b.status === 'failed';

async function start(question: string, documentId = docId) {
  return app.inject({ method: 'POST', url: '/conversations', payload: { documentId, question } });
}

async function ask(conversationId: string, question: string) {
  return app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages`, payload: { question } });
}

/** Every citation quotes the stored content exactly and points into the answer text. */
async function expectVerifiedCitations(answer: Body) {
  const { content } = (await app.inject({ method: 'GET', url: `/documents/${docId}/content` })).json();
  expect(answer.citations.length).toBeGreaterThan(0);
  for (const c of answer.citations) {
    expect(content.slice(c.startOffset, c.endOffset)).toBe(c.quote);
    expect(c.answerStart).toBeGreaterThanOrEqual(0);
    expect(c.answerEnd).toBeGreaterThan(c.answerStart);
    expect(c.answerEnd).toBeLessThanOrEqual(answer.content.length);
  }
}

const FIRST_QUESTION = 'How many questions did the hybrid prototype get right?';

/** The request the model received for `question` (the worker runs several jobs at once, so not `lastRequest`). */
function requestFor(question: string): AnswerRequest {
  const req = fake.requests.filter((r) => r.question === question).at(-1);
  if (!req) throw new Error(`no model request for ${JSON.stringify(question)}`);
  return req;
}

/** A new conversation whose first answer is terminal. */
async function conversationWithFirstAnswer(): Promise<{ conversationId: string; ids: Body; firstAnswer: Body }> {
  const res = await start(FIRST_QUESTION);
  expect(res.statusCode).toBe(202);
  const ids = res.json();
  const firstAnswer = await poll(`/messages/${ids.assistantMessageId}`, terminal);
  return { conversationId: ids.conversationId, ids, firstAnswer };
}

describe('conversation flow', () => {
  it('answers the first question with verified citations', async () => {
    const { ids, firstAnswer } = await conversationWithFirstAnswer();
    expect(ids).toEqual({
      conversationId: expect.any(String),
      userMessageId: expect.any(String),
      assistantMessageId: expect.any(String),
    });
    expect(firstAnswer).toMatchObject({
      role: 'assistant',
      status: 'completed',
      answerable: true,
      content: 'The hybrid prototype found a relevant passage for 34 of the 40 questions.',
      finishReason: 'end_turn',
      model: 'fake',
      error: null,
      attempts: 1,
      retrieval: { mode: 'full', debug: { notFoundReason: null, dropped: [] } },
    });
    expect(firstAnswer.completedAt).toEqual(expect.any(String));
    expect(firstAnswer.citations).toHaveLength(1);
    expect(firstAnswer.citations[0]).toMatchObject({
      quote: 'The hybrid prototype returned a relevant passage for 34 of the 40 questions.',
      heading: 'Results',
    });
    await expectVerifiedCitations(firstAnswer);

    // `full` mode sends every passage, in document order.
    const { passageCount } = (await app.inject({ method: 'GET', url: `/documents/${docId}` })).json();
    expect(firstAnswer.retrieval.passageOrdinals).toEqual([...Array(passageCount).keys()]);
    expect(requestFor(FIRST_QUESTION).documents).toHaveLength(passageCount);
  });

  it('sends the earlier turn as history on a follow-up', async () => {
    const { conversationId, firstAnswer } = await conversationWithFirstAnswer();
    const res = await ask(conversationId, 'And keyword search?');
    expect(res.statusCode).toBe(202);
    const answer = await poll(`/messages/${res.json().assistantMessageId}`, terminal);
    expect(answer).toMatchObject({ status: 'completed', answerable: true });
    expect(answer.citations.map((c: Body) => c.quote)).toEqual([
      'Keyword search returned a relevant passage for 28 of the 40 questions.',
      'Median response time was 0.7 seconds for keyword search and 1.2 seconds for the hybrid prototype.',
    ]);
    await expectVerifiedCitations(answer);
    // Second citation supports the second text block.
    const second = answer.citations[1];
    expect(answer.content.slice(second.answerStart, second.answerEnd)).toBe(' Its median response time was 0.7 seconds.');

    expect(requestFor('And keyword search?').history).toEqual([{ question: FIRST_QUESTION, answer: firstAnswer.content }]);

    const convo = (await app.inject({ method: 'GET', url: `/conversations/${conversationId}` })).json();
    expect(convo.documentId).toBe(docId);
    expect(convo.messages.map((m: Body) => [m.seq, m.role, m.status])).toEqual([
      [1, 'user', 'completed'],
      [2, 'assistant', 'completed'],
      [3, 'user', 'completed'],
      [4, 'assistant', 'completed'],
    ]);
    expect(convo.messages[2].content).toBe('And keyword search?');
    expect(convo.messages[0]).not.toHaveProperty('citations');
  });

  it('returns a not-found answer without citations when the model says NOT_IN_DOCUMENT', async () => {
    const res = await start('Who funded the study?');
    const answer = await poll(`/messages/${res.json().assistantMessageId}`, terminal);
    expect(answer).toMatchObject({
      status: 'completed',
      answerable: false,
      content: NOT_FOUND_MESSAGE,
      citations: [],
      retrieval: {
        debug: { notFoundReason: 'not_in_document', rawText: 'NOT_IN_DOCUMENT: the document does not mention funding.' },
      },
    });
  });

  it('treats a reply without verified citations as not found', async () => {
    const res = await start('An uncited guess?');
    const answer = await poll(`/messages/${res.json().assistantMessageId}`, terminal);
    expect(answer).toMatchObject({
      status: 'completed',
      answerable: false,
      content: NOT_FOUND_MESSAGE,
      citations: [],
      retrieval: { debug: { notFoundReason: 'no_verified_citations', rawText: 'Probably around forty questions.' } },
    });
  });
});

describe('progressive delivery and one answer at a time', () => {
  it('shows partial content while streaming and rejects a second question with 409', async () => {
    const latched = fake.whenLatched();
    const res = await start('A latched question?');
    expect(res.statusCode).toBe(202);
    const { conversationId, assistantMessageId } = res.json();
    await latched;

    const partial = await poll(`/messages/${assistantMessageId}`, (b) => b.content !== '');
    expect(partial.status).toBe('streaming');
    expect(partial.answerable).toBeNull();
    expect(partial.citations).toEqual([]);
    // FakeModel streams the first half of its text before the latch; the rest arrives after release.
    expect(partial.content.startsWith('Demo answer (fake model).')).toBe(true);

    const conflict = await ask(conversationId, 'Another question?');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: { code: 'answer_in_progress', message: expect.any(String) } });
    // The rejected question was rolled back with its transaction.
    const during = (await app.inject({ method: 'GET', url: `/conversations/${conversationId}` })).json();
    expect(during.messages).toHaveLength(2);

    fake.release('latched question');
    const answer = await poll(`/messages/${assistantMessageId}`, terminal);
    expect(answer).toMatchObject({ status: 'completed', answerable: true });
    expect(answer.content.startsWith(partial.content)).toBe(true);
    expect(answer.content.length).toBeGreaterThan(partial.content.length);
    await expectVerifiedCitations(answer);

    const next = await ask(conversationId, 'How many questions did the hybrid prototype get right?');
    expect(next.statusCode).toBe(202);
    await poll(`/messages/${next.json().assistantMessageId}`, terminal);
  });

  it('lets exactly one of several simultaneous questions through: the rest get 409, never 500', async () => {
    const { conversationId } = await conversationWithFirstAnswer();
    const latched = fake.whenLatched();
    // Without the conversation row lock these race on seq allocation (a 500 on the seq unique key); checked by
    // removing the lock: 20 requests reliably produce it, a handful may not.
    const n = 20;
    const results = await Promise.all(Array.from({ length: n }, (_, i) => ask(conversationId, `Concurrent question ${i}?`)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, ...Array(n - 1).fill(409)]);
    for (const r of results.filter((x) => x.statusCode === 409)) expect(r.json().error.code).toBe('answer_in_progress');
    await latched;

    const convo = (await app.inject({ method: 'GET', url: `/conversations/${conversationId}` })).json();
    expect(convo.messages.map((m: Body) => [m.seq, m.role])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
      [3, 'user'],
      [4, 'assistant'],
    ]);

    fake.release('concurrent question');
    const winner = results.find((r) => r.statusCode === 202)!.json();
    expect((await poll(`/messages/${winner.assistantMessageId}`, terminal)).status).toBe('completed');
  });

  it('records a permanent model error on the message and frees the conversation', async () => {
    const res = await start('Ask with a bad key');
    const { conversationId, assistantMessageId } = res.json();
    const answer = await poll(`/messages/${assistantMessageId}`, terminal);
    expect(answer).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: { code: 'model_config_error' },
      answerable: null,
    });
    const next = await ask(conversationId, 'Ask with a bad key again');
    expect(next.statusCode).toBe(202);
    await poll(`/messages/${next.json().assistantMessageId}`, terminal);
  });
});

describe('validation', () => {
  it('rejects questions on documents that are not ready', async () => {
    const pending = await insertDocument(env.pool, { title: 'queued', format: 'text', content: 'Not yet.' });
    const res = await start('Anything?', pending.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('document_not_ready');
  });

  it('rejects documents whose preparation failed', async () => {
    const up = await app.inject({ method: 'POST', url: '/documents', payload: { title: 'syntax', format: 'markdown', content: '# Only\n## Headings' } });
    const id = up.json().id;
    await poll(`/documents/${id}`, (b) => b.status === 'failed');
    const res = await start('Anything?', id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'document_not_ready', message: expect.stringContaining('empty_after_parse') });
  });

  it.each([
    ['empty question', { question: '   ' }, 'question must not be empty'],
    ['too long question', { question: 'x'.repeat(MAX_QUESTION_LENGTH + 1) }, `at most ${MAX_QUESTION_LENGTH}`],
    ['missing question', {}, 'question must be a string'],
    ['missing documentId', { noDoc: true, question: 'Hi?' }, 'documentId must be a string'],
    // Postgres rejects NUL (would be a 500) and rewrites a lone surrogate to U+FFFD.
    ['NUL in the question', { question: 'a\u0000b' }, 'NUL'],
    ['lone surrogate in the question', { question: 'broken \ud800 pair' }, 'surrogate'],
  ])('400 for %s', async (_name, body, message) => {
    const payload = 'noDoc' in body ? { question: body.question } : { documentId: docId, ...body };
    const res = await app.inject({ method: 'POST', url: '/conversations', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining(message) });
  });

  it('accepts a question of exactly the maximum length', async () => {
    const res = await start('q'.repeat(MAX_QUESTION_LENGTH));
    expect(res.statusCode).toBe(202);
    await poll(`/messages/${res.json().assistantMessageId}`, terminal);
  });

  it('400 for an empty follow-up question', async () => {
    const res = await start('How many questions did the hybrid prototype get right?');
    const { conversationId, assistantMessageId } = res.json();
    await poll(`/messages/${assistantMessageId}`, terminal);
    const bad = await ask(conversationId, '');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_request');
  });

  it('404 for unknown or malformed ids', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    const cases = [
      await start('Hi?', unknown),
      await start('Hi?', 'not-a-uuid'),
      await ask(unknown, 'Hi?'),
      await ask('nope', 'Hi?'),
      await app.inject({ method: 'GET', url: `/conversations/${unknown}` }),
      await app.inject({ method: 'GET', url: '/conversations/nope' }),
      await app.inject({ method: 'GET', url: `/messages/${unknown}` }),
      await app.inject({ method: 'GET', url: '/messages/nope' }),
    ];
    for (const res of cases) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });
});

describe('generate-answer enqueue failures on the request path', () => {
  it.each([
    ['hangs', () => new Promise(() => {})],
    ['rejects', () => Promise.reject(new Error('redis is down'))],
  ])('answers 202 with a pending answer when enqueueing %s, and the reconciler picks it up', async (_name, add) => {
    const broken = { add } as unknown as Queues['generateAnswer'];
    const brokenApp = buildApp({
      pool: env.pool,
      config: { maxDocumentBytes: 1_000_000, bodyLimitBytes: 1_500_000 },
      queues: { prepareDocument: queues.prepareDocument, generateAnswer: broken },
      enqueueTimeoutMs: 50,
    });
    try {
      // New conversation and follow-up: both routes enqueue.
      const created = await brokenApp.inject({ method: 'POST', url: '/conversations', payload: { documentId: docId, question: FIRST_QUESTION } });
      expect(created.statusCode).toBe(202);
      const { conversationId } = await conversationWithFirstAnswer();
      const followUp = await brokenApp.inject({
        method: 'POST',
        url: `/conversations/${conversationId}/messages`,
        payload: { question: FIRST_QUESTION },
      });
      expect(followUp.statusCode).toBe(202);

      const ids = [created.json().assistantMessageId, followUp.json().assistantMessageId] as string[];
      for (const id of ids) {
        expect((await app.inject({ method: 'GET', url: `/messages/${id}` })).json().status).toBe('pending');
        expect(await queues.generateAnswer.getJob(id)).toBeUndefined();
      }

      const report = await createReconciler({ pool: env.pool, queues, staleAfterMs: 0 }).runOnce();
      expect(report!.answers.enqueued).toEqual(expect.arrayContaining(ids));
      for (const id of ids) expect((await poll(`/messages/${id}`, terminal)).status).toBe('completed');
    } finally {
      await brokenApp.close();
    }
  });
});
