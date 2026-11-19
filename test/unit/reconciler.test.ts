// Reconciler error isolation with stub pool and queues (the happy paths run against real BullMQ in
// test/integration/failures.test.ts).
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Queues } from '../../src/jobs/queues.js';
import { createReconciler } from '../../src/jobs/reconciler.js';

type Rows = { documents: string[]; messages: string[] };

/** A pool whose stale-row queries return the given ids and whose guarded updates all apply. */
function stubPool(rows: Rows, opts: { failList?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT')) {
      if (opts.failList) throw new Error('connection refused');
      const ids = sql.includes('FROM documents') ? rows.documents : rows.messages;
      return { rows: ids.map((id) => ({ id, status: 'pending' })), rowCount: ids.length };
    }
    return { rows: [], rowCount: 1 };
  });
  return { query } as unknown as pg.Pool & { query: typeof query };
}

/** A queue with no jobs (so every row is enqueued), except ids whose lookup throws. */
function stubQueue(throwing: Set<string>) {
  return {
    getJob: vi.fn(async (id: string) => {
      if (throwing.has(id)) throw new Error('redis blip');
      return undefined;
    }),
    add: vi.fn(async () => ({})),
  };
}

function setup(rows: Rows, throwing: string[] = [], poolOpts: { failList?: boolean } = {}) {
  const prepareDocument = stubQueue(new Set(throwing));
  const generateAnswer = stubQueue(new Set(throwing));
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const reconciler = createReconciler({
    pool: stubPool(rows, poolOpts),
    queues: { prepareDocument, generateAnswer } as unknown as Pick<Queues, 'prepareDocument' | 'generateAnswer'>,
    log,
  });
  return { reconciler, prepareDocument, generateAnswer, log };
}

describe('reconciler error isolation', () => {
  it('logs a row whose check throws and still repairs the rows after it', async () => {
    const { reconciler, prepareDocument, generateAnswer, log } = setup(
      { documents: ['d1', 'd-bad', 'd2'], messages: ['m-bad', 'm1'] },
      ['d-bad', 'm-bad'],
    );
    const report = await reconciler.runOnce();
    expect(report).toEqual({
      documents: { enqueued: ['d1', 'd2'], failed: [], left: [] },
      answers: { enqueued: ['m1'], failed: [], left: [] },
    });
    expect(prepareDocument.add).toHaveBeenCalledTimes(2);
    expect(generateAnswer.add).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith({ documentId: 'd-bad', err: 'redis blip' }, expect.any(String));
    expect(log.error).toHaveBeenCalledWith({ messageId: 'm-bad', err: 'redis blip' }, expect.any(String));
  });

  it('resolves null (never rejects) when listing stale rows fails', async () => {
    const { reconciler, log } = setup({ documents: [], messages: [] }, [], { failList: true });
    await expect(reconciler.runOnce()).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith({ err: 'connection refused' }, 'reconciler run failed');
  });

  it('shares one pass between concurrent runOnce calls', async () => {
    const { reconciler, prepareDocument } = setup({ documents: ['d1'], messages: [] });
    const a = reconciler.runOnce();
    const b = reconciler.runOnce();
    expect(b).toBe(a);
    await a;
    expect(prepareDocument.add).toHaveBeenCalledTimes(1);
    // A later call starts a new pass.
    await reconciler.runOnce();
    expect(prepareDocument.add).toHaveBeenCalledTimes(2);
  });
});
