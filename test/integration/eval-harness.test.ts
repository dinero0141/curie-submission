// Harness check for the live eval: runs scripts/eval-runner.ts over real HTTP (a listening Fastify app) against
// real Postgres/Redis/BullMQ workers and FakeModel. This checks the harness (upload, polling, follow-up chain in
// one conversation, assertions, failure reporting) — NOT answer quality, which only `pnpm eval` against real
// Claude can measure (not run: keyless build).
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EvalSuite, parseEvalSuite } from '../../scripts/eval-check.js';
import { HarnessError, runEvalSuite } from '../../scripts/eval-runner.js';
import { loadConfig } from '../../src/config.js';
import { buildApp } from '../../src/http/app.js';
import { createGenerateAnswerWorker } from '../../src/jobs/generateAnswer.js';
import { createPrepareDocumentWorker } from '../../src/jobs/prepareDocument.js';
import { closeQueues, createQueues, createRedisConnection, type Queues } from '../../src/jobs/queues.js';
import { FakeModel, fakeCitation } from '../../src/llm/fake.js';
import type { AnswerModel, AnswerRequest } from '../../src/llm/types.js';
import { useIntegrationEnv } from './setup.js';

const env = useIntegrationEnv();
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const SUITE: EvalSuite = parseEvalSuite(JSON.parse(read('samples/eval-questions.json')));
const SAMPLE = read(SUITE.document.path);

/** Cite the sentence block containing `needle`. */
function cite(req: AnswerRequest, needle: string) {
  for (let d = 0; d < req.documents.length; d++) {
    const b = req.documents[d]!.blocks.findIndex((x) => x.includes(needle));
    if (b >= 0) return fakeCitation(req, d, b);
  }
  throw new Error(`no sent block contains ${JSON.stringify(needle)}`);
}
const answer = (text: string, needle: string) => (req: AnswerRequest) => ({ blocks: [{ text, citations: [cite(req, needle)] }] });

/** Scripted with the answers a correct model would give, so every eval row should pass. */
const correct = new FakeModel([
  { match: 'hybrid prototype get right', reply: answer('34 of the 40 questions.', '34 of the 40') },
  // Follow-up: only the history says this is about "how many questions"; the fake just checks it was sent.
  {
    match: 'and keyword search',
    reply: (req) => {
      if (!req.history.some((h) => h.question.includes('hybrid prototype get right'))) return { blocks: [{ text: 'no history' }] };
      return answer('28 of the 40.', '28 of the 40')(req);
    },
  },
  { match: 'owned the limited pilot', reply: answer('Mira Chen.', 'Mira Chen') },
  { match: 'next review', reply: answer('8 April 2026.', '8 April 2026') },
  { match: 'median response time', reply: answer('1.2 seconds.', '1.2 seconds') },
  { match: 'who funded', reply: { text: 'NOT_IN_DOCUMENT: funding is not mentioned.' } },
  { match: 'production-scale', reply: { text: 'NOT_IN_DOCUMENT: not reported.' } },
]);
/** Unscripted: the demo answer (first sentence, cited) for every question. */
const demo = new FakeModel();

let current: AnswerModel = correct;
const switchable: AnswerModel = { generate: (...args) => current.generate(...args) };

let redis: Redis;
let queues: Queues;
let workers: Worker[];
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig({ MODEL_PROVIDER: 'fake', DATABASE_URL: env.databaseUrl, REDIS_URL: env.redisUrl });
  redis = createRedisConnection(env.redisUrl);
  queues = createQueues(redis, { prefix: env.bullPrefix });
  app = buildApp({ pool: env.pool, config, queues });
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  workers = [
    createPrepareDocumentWorker(redis, { pool: env.pool, passageTokens: config.passageTokens }, { prefix: env.bullPrefix }),
    createGenerateAnswerWorker(
      redis,
      { pool: env.pool, model: switchable, fullContextTokens: config.fullContextTokens, partialWriteMs: 20 },
      { prefix: env.bullPrefix },
    ),
  ];
  await Promise.all(workers.map((w) => w.waitUntilReady()));
});

afterAll(async () => {
  await Promise.all((workers ?? []).map((w) => w.close()));
  await app?.close();
  if (queues) await closeQueues(queues);
  await redis?.quit();
});

const run = (over: Partial<Parameters<typeof runEvalSuite>[0]> = {}) =>
  runEvalSuite({ baseUrl, suite: SUITE, content: SAMPLE, pollMs: 20, documentTimeoutMs: 10_000, answerTimeoutMs: 10_000, ...over });

describe('eval harness over HTTP (FakeModel)', () => {
  it('passes every row when the model answers correctly, with the follow-up in the same conversation', async () => {
    current = correct;
    const before = correct.requests.length;
    const { rows, models } = await run();
    expect(rows.map((r) => [r.id, r.pass, r.reason])).toEqual([
      ['hybrid-correct', true, 'quote contains "34 of the 40"'],
      ['keyword-followup', true, 'quote contains "28 of the 40"'],
      ['pilot-owner', true, 'quote contains "Mira Chen"'],
      ['next-review', true, 'quote contains "8 April 2026"'],
      ['hybrid-latency', true, 'quote contains "1.2 seconds"'],
      ['funding', true, 'not found, as expected'],
      ['production-latency', true, 'not found, as expected'],
    ]);
    expect(models).toEqual(['fake']);
    const sent = correct.requests.slice(before);
    expect(sent.map((r) => r.history.length)).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it('reports content failures as rows (not a crash) when the model gives the demo answer', async () => {
    current = demo;
    const { rows } = await run();
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => !r.pass)).toBe(true);
    expect(rows.find((r) => r.id === 'hybrid-correct')!.reason).toBe(
      'no citation quote contains "34 of the 40" (1 citation(s))',
    );
    expect(rows.find((r) => r.id === 'funding')!.reason).toBe('expected not found, got answerable=true');
  });

  it('throws HarnessError when the document fails preparation or the API is unreachable', async () => {
    await expect(run({ content: '# Only a heading\n' })).rejects.toThrow(/document failed: empty_after_parse/);
    await expect(run({ baseUrl: 'http://127.0.0.1:9' })).rejects.toBeInstanceOf(HarnessError);
  });
});
