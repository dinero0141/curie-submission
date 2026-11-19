import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { getDocumentSummary, insertDocument, type DocumentSummary } from '../../src/db/documents.js';
import { listPassages } from '../../src/db/passages.js';
import { chunkDocument } from '../../src/domain/chunking.js';
import { buildApp } from '../../src/http/app.js';
import {
  createPrepareDocumentProcessor,
  createPrepareDocumentWorker,
  type PrepareDocumentResult,
} from '../../src/jobs/prepareDocument.js';
import { closeQueues, createQueues, createRedisConnection, type Queues } from '../../src/jobs/queues.js';
import { useIntegrationEnv } from './setup.js';

const env = useIntegrationEnv();
const SAMPLE = readFileSync(fileURLToPath(new URL('../../samples/harbor-archive.md', import.meta.url)), 'utf8');
const MAX_BYTES = 20_000;
const ATTEMPTS = 2;

let redis: Redis;
let queues: Queues;
let worker: Worker;
let app: FastifyInstance;
/** Swappable chunker so tests can inject transient failures; reset after each test. */
let chunk: typeof chunkDocument = chunkDocument;
/** `attemptsMade` observed by the processor on each run, keyed by document id. */
const attemptsSeen = new Map<string, number[]>();

beforeAll(async () => {
  const config = loadConfig({
    MODEL_PROVIDER: 'fake',
    DATABASE_URL: env.databaseUrl,
    REDIS_URL: env.redisUrl,
    MAX_DOCUMENT_BYTES: String(MAX_BYTES),
  });
  redis = createRedisConnection(env.redisUrl);
  queues = createQueues(redis, {
    prefix: env.bullPrefix,
    prepareDocument: { attempts: ATTEMPTS, backoff: { type: 'fixed', delay: 20 } },
  });
  app = buildApp({ pool: env.pool, config, queues });
  worker = createPrepareDocumentWorker(
    redis,
    {
      pool: env.pool,
      passageTokens: config.passageTokens,
      maxPassages: 50,
      chunk: (content, format, opts) => chunk(content, format, opts),
    },
    { prefix: env.bullPrefix },
  );
  worker.on('active', (job) => {
    const seen = attemptsSeen.get(job.data.documentId) ?? [];
    seen.push(job.attemptsMade);
    attemptsSeen.set(job.data.documentId, seen);
  });
  await worker.waitUntilReady();
});

afterEach(() => {
  chunk = chunkDocument;
});

afterAll(async () => {
  await worker?.close();
  await app?.close();
  if (queues) await closeQueues(queues);
  await redis?.quit();
});

async function upload(body: unknown) {
  return app.inject({ method: 'POST', url: '/documents', payload: body as Record<string, unknown> });
}

async function waitForTerminal(id: string, timeoutMs = 10_000): Promise<DocumentSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const doc = await getDocumentSummary(env.pool, id);
    if (doc && (doc.status === 'ready' || doc.status === 'failed')) return doc;
    if (Date.now() > deadline) throw new Error(`document ${id} still ${doc?.status} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitForJobState(id: string, state: 'completed' | 'failed') {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const job = await queues.prepareDocument.getJob(id);
    if (job && (await job.getState()) === state) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} not ${state}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('POST /documents → prepare-document', () => {
  it('prepares the sample document; passages and sentences slice the stored content', async () => {
    const res = await upload({ title: 'Harbor Archive', format: 'markdown', content: SAMPLE });
    expect(res.statusCode).toBe(202);
    const { id, status } = res.json();
    expect(status).toBe('pending');

    const doc = await waitForTerminal(id);
    expect(doc.status).toBe('ready');

    const passages = await listPassages(env.pool, id);
    expect(passages.length).toBeGreaterThan(0);
    expect(doc.passageCount).toBe(passages.length);
    passages.forEach((p, i) => {
      expect(p.ordinal).toBe(i);
      expect(p.text).toBe(SAMPLE.slice(p.start, p.end));
      expect(p.sentences.length).toBeGreaterThan(0);
      for (const s of p.sentences) {
        expect(s.start).toBeGreaterThanOrEqual(p.start);
        expect(s.end).toBeLessThanOrEqual(p.end);
        expect(SAMPLE.slice(s.start, s.end).trim()).toBe(SAMPLE.slice(s.start, s.end));
        expect(s.end).toBeGreaterThan(s.start);
      }
    });
    expect(passages.some((p) => p.heading === 'Results')).toBe(true);

    const got = await app.inject({ method: 'GET', url: `/documents/${id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({
      id,
      title: 'Harbor Archive',
      format: 'markdown',
      status: 'ready',
      passageCount: passages.length,
      utf16Length: SAMPLE.length,
      failureCode: null,
      failureMessage: null,
    });
    expect(typeof got.json().readyAt).toBe('string');

    const content = await app.inject({ method: 'GET', url: `/documents/${id}/content` });
    expect(content.statusCode).toBe(200);
    expect(content.json()).toEqual({ id, format: 'markdown', utf16Length: SAMPLE.length, content: SAMPLE });

    const list = await app.inject({ method: 'GET', url: '/documents' });
    expect(list.statusCode).toBe(200);
    const listed = list.json().documents.find((d: { id: string }) => d.id === id);
    expect(listed).toMatchObject({ id, status: 'ready' });
    expect(listed).not.toHaveProperty('content');

    // one job per document: jobId = documentId
    const job = await queues.prepareDocument.getJob(id);
    expect(job?.id).toBe(id);
  });

  it('stores the title trimmed and keeps content byte-for-byte (CRLF, emoji)', async () => {
    const content = 'Line one 🙂 is here.\r\nStill the same paragraph.\r\n\r\nSecond paragraph.';
    const res = await upload({ title: '  Notes  ', format: 'text', content });
    expect(res.statusCode).toBe(202);
    const doc = await waitForTerminal(res.json().id);
    expect(doc).toMatchObject({ status: 'ready', title: 'Notes', utf16Length: content.length });
    const passages = await listPassages(env.pool, doc.id);
    for (const p of passages) expect(p.text).toBe(content.slice(p.start, p.end));
  });

  it('fails syntax-only markdown permanently with empty_after_parse after one attempt', async () => {
    const res = await upload({ title: 'Only syntax', format: 'markdown', content: '# Heading\n\n---\n\n```\n```\n' });
    expect(res.statusCode).toBe(202);
    const id = res.json().id;
    const doc = await waitForTerminal(id);
    expect(doc).toMatchObject({ status: 'failed', failureCode: 'empty_after_parse', passageCount: null });
    expect(doc.failureMessage).toBeTruthy();

    const job = await waitForJobState(id, 'failed');
    expect(job.attemptsMade).toBe(1); // UnrecoverableError: no retry despite attempts = 2
    expect(attemptsSeen.get(id)).toEqual([0]);
    expect(await listPassages(env.pool, id)).toEqual([]);

    const got = await app.inject({ method: 'GET', url: `/documents/${id}` });
    expect(got.json()).toMatchObject({ status: 'failed', failureCode: 'empty_after_parse' });
  });

  it('fails permanently with too_many_passages above the passage cap', async () => {
    const content = Array.from({ length: 60 }, (_, i) => `# H${i}\n\nSentence ${i}.`).join('\n\n');
    const res = await upload({ title: 'Many headings', format: 'markdown', content });
    const id = res.json().id;
    const doc = await waitForTerminal(id);
    expect(doc).toMatchObject({ status: 'failed', failureCode: 'too_many_passages' });
    expect(attemptsSeen.get(id)).toEqual([0]);
  });

  it('retries a transient error and succeeds on the next attempt', async () => {
    let calls = 0;
    chunk = (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('transient glitch');
      return chunkDocument(...args);
    };
    const res = await upload({ title: 'Flaky', format: 'text', content: 'One sentence. Two sentences.' });
    const id = res.json().id;
    const doc = await waitForTerminal(id);
    expect(doc.status).toBe('ready');
    expect(doc.failureCode).toBeNull();
    // BullMQ semantics this processor relies on: attemptsMade counts *finished* attempts (0 on the first run).
    expect(attemptsSeen.get(id)).toEqual([0, 1]);
  });

  it('writes failed/preparation_error itself on the final transient attempt (final-state rule)', async () => {
    chunk = () => {
      throw new Error('database hiccup');
    };
    const res = await upload({ title: 'Always failing', format: 'text', content: 'Some text.' });
    const id = res.json().id;
    const doc = await waitForTerminal(id);
    expect(doc).toMatchObject({ status: 'failed', failureCode: 'preparation_error' });
    expect(doc.failureMessage).toContain('database hiccup');
    // Both attempts ran the processor and the job ended `failed`. Had the first (non-final) attempt
    // written `failed`, the second would have skipped the terminal row and the job would be `completed`.
    const job = await waitForJobState(id, 'failed');
    expect(job.attemptsMade).toBe(ATTEMPTS);
    expect(attemptsSeen.get(id)).toEqual([0, 1]);
  });

  it('re-running preparation is idempotent', async () => {
    const res = await upload({ title: 'Rerun', format: 'markdown', content: SAMPLE });
    const id = res.json().id;
    await waitForTerminal(id);
    const before = await listPassages(env.pool, id);

    const run = createPrepareDocumentProcessor({ pool: env.pool, passageTokens: 400 });
    const job = { id, data: { documentId: id }, attemptsMade: 0, opts: { attempts: 1 } };

    // a stale rerun of a ready document is a no-op (same passage rows)
    expect(await run(job)).toEqual<PrepareDocumentResult>({ outcome: 'skipped', reason: 'terminal' });
    expect(await listPassages(env.pool, id)).toEqual(before);

    // a rerun of an in-flight document replaces passages: same spans, no duplicates
    await env.pool.query(`UPDATE documents SET status = 'processing' WHERE id = $1`, [id]);
    expect(await run(job)).toEqual<PrepareDocumentResult>({ outcome: 'ready', passageCount: before.length });
    const after = await listPassages(env.pool, id);
    const strip = (ps: typeof before) => ps.map(({ id: _id, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
    expect((await getDocumentSummary(env.pool, id))?.status).toBe('ready');

    // a job for a deleted document is skipped, not failed
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect(await run({ ...job, id: ghost, data: { documentId: ghost } })).toEqual({ outcome: 'skipped', reason: 'missing' });
  });

  it('does not overwrite a ready document when a late failure arrives', async () => {
    const doc = await insertDocument(env.pool, { title: 'x', format: 'text', content: 'Hello there.' });
    const run = createPrepareDocumentProcessor({ pool: env.pool, passageTokens: 400 });
    await run({ id: doc.id, data: { documentId: doc.id }, attemptsMade: 0, opts: { attempts: 1 } });
    const failing = createPrepareDocumentProcessor({
      pool: env.pool,
      passageTokens: 400,
      chunk: () => {
        throw new Error('boom');
      },
    });
    // terminal row: guarded transition skips before chunking, so nothing is overwritten
    await expect(
      failing({ id: doc.id, data: { documentId: doc.id }, attemptsMade: 0, opts: { attempts: 1 } }),
    ).resolves.toEqual({ outcome: 'skipped', reason: 'terminal' });
    expect((await getDocumentSummary(env.pool, doc.id))?.status).toBe('ready');
  });
});

describe('POST /documents validation', () => {
  const valid = { title: 'T', format: 'markdown', content: 'Hello.' };

  it.each([
    ['whitespace-only content', { ...valid, content: ' \n\t \r\n ' }, 'empty_document'],
    ['empty content', { ...valid, content: '' }, 'empty_document'],
    ['unknown format', { ...valid, format: 'pdf' }, 'invalid_request'],
    ['missing format', { title: 'T', content: 'x' }, 'invalid_request'],
    ['empty title', { ...valid, title: '   ' }, 'invalid_request'],
    ['non-string content', { ...valid, content: 42 }, 'invalid_request'],
    ['NUL character', { ...valid, content: 'a\u0000b' }, 'invalid_content'],
    ['lone surrogate', { ...valid, content: 'broken \ud800 pair' }, 'invalid_content'],
  ])('rejects %s with 400', async (_name, body, code) => {
    const before = (await env.pool.query('SELECT count(*)::int AS n FROM documents')).rows[0].n;
    const res = await upload(body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code, message: expect.any(String) } });
    const after = (await env.pool.query('SELECT count(*)::int AS n FROM documents')).rows[0].n;
    expect(after).toBe(before);
  });

  it('rejects a body that is not a JSON object or not JSON', async () => {
    const arr = await upload([1, 2]);
    expect(arr.statusCode).toBe(400);
    expect(arr.json().error.code).toBe('invalid_request');

    const bad = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { 'content-type': 'application/json' },
      payload: '{"title":',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_json');

    const text = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { 'content-type': 'text/markdown' },
      payload: '# hi',
    });
    expect(text.statusCode).toBe(415);
    expect(text.json().error.code).toBe('unsupported_media_type');
  });

  it('returns 413 when content exceeds MAX_DOCUMENT_BYTES in UTF-8 bytes', async () => {
    // 'é' is 1 UTF-16 unit but 2 UTF-8 bytes: under the limit in length, over it in bytes
    const content = 'é'.repeat(MAX_BYTES / 2 + 1);
    expect(content.length).toBeLessThan(MAX_BYTES);
    const res = await upload({ ...valid, content });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: { code: 'document_too_large', message: expect.stringContaining('bytes') } });

    const atLimit = await upload({ ...valid, content: 'a'.repeat(MAX_BYTES) });
    expect(atLimit.statusCode).toBe(202);
  });

  it('returns 413 with the envelope when the whole body exceeds the body limit', async () => {
    const res = await upload({ ...valid, content: 'a'.repeat(MAX_BYTES * 2) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
  });
});

describe('GET /documents/:id', () => {
  it('returns 404 envelopes for unknown and malformed ids and unknown routes', async () => {
    const unknown = '3f1c2b9a-0000-4000-8000-000000000001';
    for (const url of [`/documents/${unknown}`, `/documents/${unknown}/content`, '/documents/not-a-uuid']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'not_found', message: 'document not found' } });
    }
    const route = await app.inject({ method: 'GET', url: '/nope' });
    expect(route.statusCode).toBe(404);
    expect(route.json().error.code).toBe('not_found');
  });

  it('shows pending documents before the worker picks them up', async () => {
    const doc = await insertDocument(env.pool, { title: 'queued', format: 'text', content: 'Waiting.' });
    const res = await app.inject({ method: 'GET', url: `/documents/${doc.id}` });
    expect(res.json()).toMatchObject({ status: 'pending', passageCount: null, readyAt: null });
  });
});

describe('enqueue failures on the request path', () => {
  it('still answers 202 with a pending row when enqueueing hangs (reconciler picks it up)', async () => {
    const stuck = {
      add: () => new Promise(() => {}),
    } as unknown as Queues['prepareDocument'];
    const slowApp = buildApp({
      pool: env.pool,
      config: { maxDocumentBytes: MAX_BYTES, bodyLimitBytes: MAX_BYTES * 1.5 },
      queues: { prepareDocument: stuck },
      enqueueTimeoutMs: 50,
    });
    try {
      const res = await slowApp.inject({
        method: 'POST',
        url: '/documents',
        payload: { title: 'T', format: 'text', content: 'Hi.' },
      });
      expect(res.statusCode).toBe(202);
      expect((await getDocumentSummary(env.pool, res.json().id))?.status).toBe('pending');
    } finally {
      await slowApp.close();
    }
  });
});
