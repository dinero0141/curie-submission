// Failure handling for generate-answer (final-state rule, retries, permanent errors, refusal, max_tokens)
// and the reconciler, against real Postgres/Redis/BullMQ workers and the scripted FakeModel. Model errors
// are real `@anthropic-ai/sdk` error instances; the Citations shapes are the assumed ones from
// docs/notes/citations-spike.md (not observed live — keyless run).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { UnrecoverableError, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { insertConversation } from '../../src/db/conversations.js';
import { getDocumentSummary, insertDocument, markDocumentProcessing } from '../../src/db/documents.js';
import { getMessage, insertMessage, startAnswer } from '../../src/db/messages.js';
import { buildApp } from '../../src/http/app.js';
import { createGenerateAnswerProcessor, createGenerateAnswerWorker } from '../../src/jobs/generateAnswer.js';
import { createPrepareDocumentWorker } from '../../src/jobs/prepareDocument.js';
import {
  closeQueues,
  createQueues,
  createRedisConnection,
  QUEUE_NAMES,
  type GenerateAnswerJobData,
  type PrepareDocumentJobData,
  type Queues,
} from '../../src/jobs/queues.js';
import { createReconciler, STALLED } from '../../src/jobs/reconciler.js';
import { FakeModel, fakeCitation } from '../../src/llm/fake.js';
import { useIntegrationEnv } from './setup.js';

const env = useIntegrationEnv();
const SAMPLE = readFileSync(fileURLToPath(new URL('../../samples/harbor-archive.md', import.meta.url)), 'utf8');
const ATTEMPTS = 3;

const apiError = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers());
const overloaded = () => apiError(529, 'overloaded_error', 'Overloaded');

const fake = new FakeModel();
fake.script({ match: 'transient once', errors: [overloaded()] });
fake.script({
  match: 'two different transients',
  errors: [new Anthropic.APIConnectionError({ message: 'socket hang up' }), apiError(429, 'rate_limit_error', 'slow down')],
});
fake.script({ match: 'always overloaded', errors: [overloaded(), overloaded(), overloaded()] });
fake.script({ match: 'bad key', errors: [apiError(401, 'authentication_error', 'invalid x-api-key')] });
fake.script({
  match: 'huge prompt',
  errors: [apiError(400, 'invalid_request_error', 'prompt is too long: 1234567 tokens > 1000000 maximum')],
});
fake.script({ match: 'please refuse', reply: { text: 'I will not help with that.', stopReason: 'refusal' } });
fake.script({
  match: 'truncated answer',
  reply: (req) => ({
    blocks: [{ text: 'The prototype found a relevant passage for', citations: [fakeCitation(req, 0, 0)] }],
    stopReason: 'max_tokens',
  }),
});
fake.script({ match: 'retry later', errors: [overloaded()] });

let redis: Redis;
let queues: Queues;
let workers: Worker[];
let app: FastifyInstance;
let docId: string;
/** `job.attemptsMade` seen when each generate-answer run starts, keyed by message id. */
const attemptsSeen = new Map<string, number[]>();

beforeAll(async () => {
  const config = loadConfig({ MODEL_PROVIDER: 'fake', DATABASE_URL: env.databaseUrl, REDIS_URL: env.redisUrl });
  redis = createRedisConnection(env.redisUrl);
  queues = createQueues(redis, {
    prefix: env.bullPrefix,
    prepareDocument: { backoff: { type: 'fixed', delay: 20 } },
    generateAnswer: { attempts: ATTEMPTS, backoff: { type: 'fixed', delay: 20 } },
  });
  app = buildApp({ pool: env.pool, config, queues });
  const answers = createGenerateAnswerWorker(
    redis,
    { pool: env.pool, model: fake, fullContextTokens: config.fullContextTokens, partialWriteMs: 20 },
    { prefix: env.bullPrefix },
  );
  answers.on('active', (job) => {
    attemptsSeen.set(job.data.messageId, [...(attemptsSeen.get(job.data.messageId) ?? []), job.attemptsMade]);
  });
  workers = [
    createPrepareDocumentWorker(redis, { pool: env.pool, passageTokens: config.passageTokens }, { prefix: env.bullPrefix }),
    answers,
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

async function start(question: string) {
  const res = await app.inject({ method: 'POST', url: '/conversations', payload: { documentId: docId, question } });
  expect(res.statusCode).toBe(202);
  return res.json() as { conversationId: string; userMessageId: string; assistantMessageId: string };
}

async function ask(conversationId: string, question: string) {
  return app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages`, payload: { question } });
}

async function answerOf(question: string) {
  const ids = await start(question);
  return { ids, answer: await poll(`/messages/${ids.assistantMessageId}`, terminal) };
}

/** A conversation turn written straight to the database, with no job enqueued (a lost enqueue). */
async function seedTurn(question: string) {
  const convo = await insertConversation(env.pool, docId);
  await insertMessage(env.pool, { conversationId: convo.id, role: 'user', content: question });
  const assistant = await insertMessage(env.pool, { conversationId: convo.id, role: 'assistant' });
  return { conversationId: convo.id, messageId: assistant.id };
}

async function age(table: 'messages' | 'documents', id: string, minutes = 5) {
  await env.pool.query(`UPDATE ${table} SET updated_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, minutes]);
}

describe('generate-answer final-state rule', () => {
  it('retries a transient error and completes on the next attempt', async () => {
    const { ids, answer } = await answerOf('A transient once question?');
    expect(answer).toMatchObject({ status: 'completed', answerable: true, attempts: 2, error: null });
    // BullMQ 6.7.7 semantics the final-attempt check relies on: 0 on the first run, +1 per finished attempt.
    expect(attemptsSeen.get(ids.assistantMessageId)).toEqual([0, 1]);
  });

  it('retries different transient error classes (connection error, 429)', async () => {
    const { answer } = await answerOf('Two different transients?');
    expect(answer).toMatchObject({ status: 'completed', attempts: 3, error: null });
  });

  it('fails with model_unavailable after the last transient attempt and frees the conversation', async () => {
    const { ids, answer } = await answerOf('Is it always overloaded?');
    expect(answer).toMatchObject({
      status: 'failed',
      attempts: ATTEMPTS,
      content: '',
      answerable: null,
      error: { code: 'model_unavailable', message: expect.stringContaining('Overloaded') },
    });
    expect(attemptsSeen.get(ids.assistantMessageId)).toEqual([0, 1, 2]);
    const job = await queues.generateAnswer.getJob(ids.assistantMessageId);
    expect(await job!.getState()).toBe('failed');
    expect(job!.attemptsMade).toBe(ATTEMPTS);

    // The next question is accepted, and the failed turn is not sent as history.
    const next = await ask(ids.conversationId, 'How many questions did the hybrid prototype get right?');
    expect(next.statusCode).toBe(202);
    const answer2 = await poll(`/messages/${next.json().assistantMessageId}`, terminal);
    expect(answer2.status).toBe('completed');
    expect(fake.lastRequest!.question).toBe('How many questions did the hybrid prototype get right?');
    expect(fake.lastRequest!.history).toEqual([]);

    const convo = (await app.inject({ method: 'GET', url: `/conversations/${ids.conversationId}` })).json();
    expect(convo.messages.map((m: Body) => [m.seq, m.role, m.status])).toEqual([
      [1, 'user', 'completed'],
      [2, 'assistant', 'failed'],
      [3, 'user', 'completed'],
      [4, 'assistant', 'completed'],
    ]);
  });

  it('fails a 401 permanently after one attempt (model_config_error)', async () => {
    const { ids, answer } = await answerOf('Ask with a bad key');
    expect(answer).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'model_config_error' } });
    expect(attemptsSeen.get(ids.assistantMessageId)).toEqual([0]);
    const job = await queues.generateAnswer.getJob(ids.assistantMessageId);
    expect(await job!.getState()).toBe('failed');
    expect(job!.failedReason).toContain('model_config_error');
  });

  it('fails an over-long prompt permanently after one attempt (context_too_large)', async () => {
    const { ids, answer } = await answerOf('A huge prompt question?');
    expect(answer).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'context_too_large' } });
    expect(attemptsSeen.get(ids.assistantMessageId)).toEqual([0]);
  });

  it('fails a refusal permanently (model_refused) without keeping the partial text', async () => {
    const { ids, answer } = await answerOf('Would you please refuse?');
    expect(answer).toMatchObject({ status: 'failed', attempts: 1, content: '', error: { code: 'model_refused' } });
    expect(attemptsSeen.get(ids.assistantMessageId)).toEqual([0]);
  });

  it('completes a max_tokens answer and reports the finish reason', async () => {
    const { answer } = await answerOf('A truncated answer?');
    expect(answer).toMatchObject({
      status: 'completed',
      answerable: true,
      finishReason: 'max_tokens',
      content: 'The prototype found a relevant passage for',
      attempts: 1,
    });
    expect(answer.citations).toHaveLength(1);
  });

  it('puts a row back to pending without partial content between retries', async () => {
    // Drive the processor directly (no worker) to observe the state between attempts deterministically.
    const { messageId } = await seedTurn('Retry later please?');
    const processor = createGenerateAnswerProcessor({ pool: env.pool, model: fake, fullContextTokens: 60_000 });
    const job = (attemptsMade: number) => ({ id: messageId, data: { messageId }, attemptsMade, opts: { attempts: ATTEMPTS } });

    await expect(processor(job(0))).rejects.toBeInstanceOf(Anthropic.InternalServerError);
    expect(await getMessage(env.pool, messageId)).toMatchObject({ status: 'pending', content: '', attempts: 1, errorCode: null });

    await expect(processor(job(1))).resolves.toMatchObject({ outcome: 'completed' });
    expect(await getMessage(env.pool, messageId)).toMatchObject({ status: 'completed', attempts: 2 });
  });
});

describe('reconciler', () => {
  /** Queues on a separate prefix with a scripted worker standing in for a processor whose final write was lost. */
  let orphanQueues: Queues;
  let orphanWorkers: Worker[];
  const behaviour = new Map<string, 'fail' | 'complete'>();

  beforeAll(async () => {
    const prefix = `${env.bullPrefix}:orphan`;
    orphanQueues = createQueues(redis, { prefix, generateAnswer: { attempts: 1 }, prepareDocument: { attempts: 1 } });
    const run = (id: string) => {
      if (behaviour.get(id) === 'fail') throw new UnrecoverableError('worker crashed before recording the failure');
      return { outcome: 'skipped' };
    };
    orphanWorkers = [
      new Worker<GenerateAnswerJobData>(QUEUE_NAMES.generateAnswer, async (job) => run(job.data.messageId), { connection: redis, prefix }),
      new Worker<PrepareDocumentJobData>(QUEUE_NAMES.prepareDocument, async (job) => run(job.data.documentId), { connection: redis, prefix }),
    ];
    await Promise.all(orphanWorkers.map((w) => w.waitUntilReady()));
  });

  afterAll(async () => {
    await Promise.all((orphanWorkers ?? []).map((w) => w.close()));
    if (orphanQueues) await closeQueues(orphanQueues);
  });

  /** Add a job on the orphan queues and wait until it is finished in the given way. */
  async function finishOrphanJob(kind: 'generateAnswer' | 'prepareDocument', id: string, how: 'fail' | 'complete') {
    behaviour.set(id, how);
    if (kind === 'generateAnswer') await orphanQueues.generateAnswer.add('orphan', { messageId: id }, { jobId: id });
    else await orphanQueues.prepareDocument.add('orphan', { documentId: id }, { jobId: id });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const state = await (await orphanQueues[kind].getJob(id))?.getState();
      if (state === (how === 'fail' ? 'failed' : 'completed')) return;
      if (Date.now() > deadline) throw new Error(`orphan job ${id} is ${state}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  it('enqueues a stale pending answer that has no job, and it completes', async () => {
    const { messageId } = await seedTurn('How many questions did the hybrid prototype get right?');
    await age('messages', messageId);
    expect(await queues.generateAnswer.getJob(messageId)).toBeUndefined();

    const report = await createReconciler({ pool: env.pool, queues }).runOnce();
    expect(report!.answers.enqueued).toContain(messageId);

    const answer = await poll(`/messages/${messageId}`, terminal);
    expect(answer).toMatchObject({ status: 'completed', answerable: true, attempts: 1 });
  });

  it('leaves fresh in-flight rows alone', async () => {
    const { messageId } = await seedTurn('A fresh question?');
    const report = await createReconciler({ pool: env.pool, queues: orphanQueues }).runOnce();
    expect(Object.values(report!.answers).flat()).not.toContain(messageId);
    expect(await orphanQueues.generateAnswer.getJob(messageId)).toBeUndefined();
    expect((await getMessage(env.pool, messageId))!.status).toBe('pending');
    // Clean up so the conversation does not keep an in-flight answer.
    await env.pool.query(`UPDATE messages SET status = 'failed' WHERE id = $1`, [messageId]);
  });

  it('fails a stale streaming answer whose job is in the failed set, and the conversation accepts a new question', async () => {
    const { conversationId, messageId } = await seedTurn('Stuck streaming?');
    await startAnswer(env.pool, messageId); // streaming, as if a worker had started it
    await env.pool.query(`UPDATE messages SET content = 'partial text' WHERE id = $1`, [messageId]);
    await finishOrphanJob('generateAnswer', messageId, 'fail');
    await age('messages', messageId);

    const report = await createReconciler({ pool: env.pool, queues: orphanQueues }).runOnce();
    expect(report!.answers.failed).toContain(messageId);
    const row = await getMessage(env.pool, messageId);
    expect(row).toMatchObject({ status: 'failed', content: '', errorCode: STALLED });
    expect(row!.errorMessage).toContain('worker crashed before recording the failure');

    const next = await ask(conversationId, 'How many questions did the hybrid prototype get right?');
    expect(next.statusCode).toBe(202);
    expect((await poll(`/messages/${next.json().assistantMessageId}`, terminal)).status).toBe('completed');
  });

  it('fails a stale answer whose job completed without finishing the row', async () => {
    const { messageId } = await seedTurn('Completed but left pending?');
    await finishOrphanJob('generateAnswer', messageId, 'complete');
    await age('messages', messageId);

    const report = await createReconciler({ pool: env.pool, queues: orphanQueues }).runOnce();
    expect(report!.answers.failed).toContain(messageId);
    expect(await getMessage(env.pool, messageId)).toMatchObject({ status: 'failed', errorCode: STALLED });
  });

  it('leaves a stale row whose job is still waiting or delayed', async () => {
    const { messageId } = await seedTurn('Delayed job?');
    await orphanQueues.generateAnswer.add('delayed', { messageId }, { jobId: messageId, delay: 60_000 });
    await age('messages', messageId);

    const report = await createReconciler({ pool: env.pool, queues: orphanQueues }).runOnce();
    expect(report!.answers.left).toContain(messageId);
    expect((await getMessage(env.pool, messageId))!.status).toBe('pending');
    await (await orphanQueues.generateAnswer.getJob(messageId))!.remove();
    await env.pool.query(`UPDATE messages SET status = 'failed' WHERE id = $1`, [messageId]);
  });

  it('enqueues a stale pending document with no job, and it becomes ready', async () => {
    const doc = await insertDocument(env.pool, { title: 'lost enqueue', format: 'text', content: 'One sentence. Two sentences.' });
    await age('documents', doc.id);

    const report = await createReconciler({ pool: env.pool, queues }).runOnce();
    expect(report!.documents.enqueued).toContain(doc.id);
    const ready = await poll(`/documents/${doc.id}`, (b) => b.status === 'ready' || b.status === 'failed');
    expect(ready).toMatchObject({ status: 'ready', passageCount: 1 });
  });

  it('fails a stale processing document whose job is in the failed set', async () => {
    const doc = await insertDocument(env.pool, { title: 'crashed', format: 'text', content: 'Some text.' });
    await markDocumentProcessing(env.pool, doc.id);
    await finishOrphanJob('prepareDocument', doc.id, 'fail');
    await age('documents', doc.id);

    const report = await createReconciler({ pool: env.pool, queues: orphanQueues }).runOnce();
    expect(report!.documents.failed).toContain(doc.id);
    expect(await getDocumentSummary(env.pool, doc.id)).toMatchObject({ status: 'failed', failureCode: STALLED });
  });

  it('runs on start and on its interval until stopped', async () => {
    const reconciler = createReconciler({ pool: env.pool, queues, intervalMs: 30 });
    reconciler.start();
    await reconciler.runOnce(); // joins the pass started by start()

    // Lost after the first pass: picked up by a later interval tick.
    const { messageId } = await seedTurn('How many questions did the hybrid prototype get right?');
    await age('messages', messageId);
    const answer = await poll(`/messages/${messageId}`, terminal);
    expect(answer.status).toBe('completed');
    await reconciler.stop();
  });
});
