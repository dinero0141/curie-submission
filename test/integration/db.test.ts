import { describe, expect, it } from 'vitest';
import { insertConversation, lockConversation } from '../../src/db/conversations.js';
import {
  getDocument,
  insertDocument,
  listDocuments,
  listStaleInFlightDocuments,
  markDocumentFailed,
  markDocumentProcessing,
  markDocumentReady,
} from '../../src/db/documents.js';
import {
  completeAnswer,
  failAnswer,
  getMessage,
  insertMessage,
  listMessages,
  ONE_INFLIGHT_ANSWER,
  startAnswer,
  writePartialContent,
} from '../../src/db/messages.js';
import { migrate } from '../../src/db/migrate.js';
import { getPassagesByOrdinals, listPassages, replacePassages, type NewPassage } from '../../src/db/passages.js';
import { isUniqueViolation, withTx } from '../../src/db/pool.js';
import { useIntegrationEnv } from './setup.js';

const env = useIntegrationEnv();

const CONTENT = '# Results\n\nThe hybrid prototype answered 41 questions. Keyword search 🔎 answered 29.\n';

function passagesFor(content: string): NewPassage[] {
  const s1 = content.indexOf('The hybrid');
  const e1 = content.indexOf('questions.') + 'questions.'.length;
  const s2 = content.indexOf('Keyword');
  const e2 = content.indexOf('29.') + '29.'.length;
  return [
    {
      ordinal: 0,
      start: s1,
      end: e2,
      heading: 'Results',
      sentences: [
        { start: s1, end: e1 },
        { start: s2, end: e2 },
      ],
      text: content.slice(s1, e2),
      tokenEstimate: 20,
    },
  ];
}

async function schemaSnapshot(): Promise<unknown> {
  const cols = await env.pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const idx = await env.pool.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
  );
  const cons = await env.pool.query(
    `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY conname`,
  );
  return { cols: cols.rows, idx: idx.rows, cons: cons.rows };
}

async function newConversation(): Promise<string> {
  const doc = await insertDocument(env.pool, { title: 'Doc', format: 'markdown', content: CONTENT });
  const conv = await insertConversation(env.pool, doc.id);
  return conv.id;
}

describe('harness', () => {
  it('gives each test file its own BullMQ prefix', () => {
    expect(env.bullPrefix).toMatch(/^curie-test:db:[0-9a-f]{8}$/);
  });
});

describe('migration', () => {
  it('re-running is a no-op: schema and data unchanged', async () => {
    const doc = await insertDocument(env.pool, { title: 'Keep me', format: 'text', content: 'hello' });
    const before = await schemaSnapshot();

    const applied = await migrate(env.pool);
    await migrate(env.pool);

    expect(applied).toContain('001_init.sql');
    expect(await schemaSnapshot()).toEqual(before);
    expect((await getDocument(env.pool, doc.id))?.title).toBe('Keep me');
  });
});

describe('documents', () => {
  it('stores content verbatim with JS (UTF-16) length and walks the status lifecycle', async () => {
    const doc = await insertDocument(env.pool, { title: 'Sample', format: 'markdown', content: CONTENT });
    expect(doc).toMatchObject({ status: 'pending', utf16Length: CONTENT.length, passageCount: null });
    // emoji is 2 UTF-16 code units; the stored length must match String#length, not code points
    expect(doc.utf16Length).toBe([...CONTENT].length + 1);

    expect(await markDocumentProcessing(env.pool, doc.id)).toBe(true);
    await markDocumentReady(env.pool, doc.id, 1);
    const ready = await getDocument(env.pool, doc.id);
    expect(ready).toMatchObject({ status: 'ready', passageCount: 1, content: CONTENT });
    expect(ready?.readyAt).toBeInstanceOf(Date);

    // terminal documents are not moved back to processing (stale job rerun)
    expect(await markDocumentProcessing(env.pool, doc.id)).toBe(false);

    const failed = await insertDocument(env.pool, { title: 'Bad', format: 'markdown', content: '---' });
    await markDocumentFailed(env.pool, failed.id, 'empty_after_parse', 'No text left after parsing');
    expect(await getDocument(env.pool, failed.id)).toMatchObject({
      status: 'failed',
      failureCode: 'empty_after_parse',
      failureMessage: 'No text left after parsing',
    });

    const ids = (await listDocuments(env.pool)).map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining([doc.id, failed.id]));
  });

  it('rejects unknown formats at the database level', async () => {
    await expect(
      insertDocument(env.pool, { title: 'x', format: 'pdf' as 'text', content: 'x' }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('lists only stale in-flight documents', async () => {
    const stale = await insertDocument(env.pool, { title: 'stale', format: 'text', content: 'a' });
    const fresh = await insertDocument(env.pool, { title: 'fresh', format: 'text', content: 'b' });
    const done = await insertDocument(env.pool, { title: 'done', format: 'text', content: 'c' });
    await markDocumentReady(env.pool, done.id, 1);
    await env.pool.query(`UPDATE documents SET updated_at = now() - interval '5 minutes' WHERE id = ANY($1)`, [
      [stale.id, done.id],
    ]);

    const ids = (await listStaleInFlightDocuments(env.pool, 120_000)).map((d) => d.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
    expect(ids).not.toContain(done.id);
  });
});

describe('passages', () => {
  it('populates tsv (english stemming over heading + text) and round-trips spans', async () => {
    const doc = await insertDocument(env.pool, { title: 'Sample', format: 'markdown', content: CONTENT });
    const passages = passagesFor(CONTENT);
    await withTx(env.pool, (tx) => replacePassages(tx, doc.id, passages));

    const tsv = await env.pool.query<{ tsv: string; hit: boolean; heading_hit: boolean }>(
      `SELECT tsv::text AS tsv,
              tsv @@ plainto_tsquery('english', 'answering prototypes') AS hit,
              tsv @@ plainto_tsquery('english', 'results') AS heading_hit
       FROM passages WHERE document_id = $1`,
      [doc.id],
    );
    expect(tsv.rows).toHaveLength(1);
    expect(tsv.rows[0]?.tsv).toContain("'hybrid'");
    expect(tsv.rows[0]?.hit).toBe(true);
    expect(tsv.rows[0]?.heading_hit).toBe(true);

    const rows = await listPassages(env.pool, doc.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ ordinal: 0, heading: 'Results', sentences: passages[0]!.sentences });
    // stored spans slice the original content exactly (JS slicing, UTF-16 offsets)
    expect(CONTENT.slice(row.start, row.end)).toBe(row.text);
    expect(row.sentences.map((s) => CONTENT.slice(s.start, s.end))).toEqual([
      'The hybrid prototype answered 41 questions.',
      'Keyword search 🔎 answered 29.',
    ]);
  });

  it('replacePassages is idempotent and handles many rows', async () => {
    const doc = await insertDocument(env.pool, { title: 'Big', format: 'text', content: 'x'.repeat(2000) });
    const many: NewPassage[] = Array.from({ length: 1200 }, (_, i) => ({
      ordinal: i,
      start: i,
      end: i + 1,
      heading: null,
      sentences: [{ start: i, end: i + 1 }],
      text: 'x',
      tokenEstimate: 1,
    }));
    await withTx(env.pool, (tx) => replacePassages(tx, doc.id, many));
    await withTx(env.pool, (tx) => replacePassages(tx, doc.id, many));

    expect(await listPassages(env.pool, doc.id)).toHaveLength(1200);
    expect((await getPassagesByOrdinals(env.pool, doc.id, [5, 1, 3])).map((p) => p.ordinal)).toEqual([1, 3, 5]);
    expect(await getPassagesByOrdinals(env.pool, doc.id, [])).toEqual([]);
  });

  it('withTx rolls back on error', async () => {
    const doc = await insertDocument(env.pool, { title: 'Rollback', format: 'markdown', content: CONTENT });
    await withTx(env.pool, (tx) => replacePassages(tx, doc.id, passagesFor(CONTENT)));

    await expect(
      withTx(env.pool, async (tx) => {
        await replacePassages(tx, doc.id, []);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await listPassages(env.pool, doc.id)).toHaveLength(1);
  });

  it('cascades on document delete', async () => {
    const doc = await insertDocument(env.pool, { title: 'Gone', format: 'markdown', content: CONTENT });
    await withTx(env.pool, (tx) => replacePassages(tx, doc.id, passagesFor(CONTENT)));
    await env.pool.query('DELETE FROM documents WHERE id = $1', [doc.id]);
    expect(await listPassages(env.pool, doc.id)).toHaveLength(0);
  });
});

describe('messages', () => {
  it('allocates seq under the conversation lock', async () => {
    const convId = await newConversation();
    const ids = await withTx(env.pool, async (tx) => {
      expect(await lockConversation(tx, convId)).not.toBeNull();
      const u = await insertMessage(tx, { conversationId: convId, role: 'user', content: 'Q1' });
      const a = await insertMessage(tx, { conversationId: convId, role: 'assistant' });
      return [u, a];
    });
    expect(ids.map((m) => [m.seq, m.role, m.status])).toEqual([
      [1, 'user', 'completed'],
      [2, 'assistant', 'pending'],
    ]);
    expect(ids[0]?.completedAt).toBeInstanceOf(Date);
    expect(ids[1]?.completedAt).toBeNull();
    expect(await lockConversation(env.pool, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('one_inflight_answer rejects a second in-flight assistant message but allows user messages', async () => {
    const convId = await newConversation();
    await insertMessage(env.pool, { conversationId: convId, role: 'user', content: 'Q1' });
    const first = await insertMessage(env.pool, { conversationId: convId, role: 'assistant' });

    // user messages are never blocked
    await insertMessage(env.pool, { conversationId: convId, role: 'user', content: 'Q2' });

    const err = await insertMessage(env.pool, { conversationId: convId, role: 'assistant' }).catch((e: unknown) => e);
    expect(isUniqueViolation(err, ONE_INFLIGHT_ANSWER)).toBe(true);
    expect(isUniqueViolation(err, 'messages_conversation_seq_key')).toBe(false);

    // still blocked while streaming
    await startAnswer(env.pool, first.id);
    const err2 = await insertMessage(env.pool, { conversationId: convId, role: 'assistant' }).catch((e: unknown) => e);
    expect(isUniqueViolation(err2, ONE_INFLIGHT_ANSWER)).toBe(true);

    // a terminal answer frees the slot; other conversations are independent
    await failAnswer(env.pool, first.id, 'model_unavailable', 'try again');
    const next = await insertMessage(env.pool, { conversationId: convId, role: 'assistant' });
    expect(next.status).toBe('pending');

    const otherConv = await newConversation();
    await expect(insertMessage(env.pool, { conversationId: otherConv, role: 'assistant' })).resolves.toBeTruthy();

    expect((await listMessages(env.pool, convId)).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });

  it('seq collisions surface as a different unique violation', async () => {
    const convId = await newConversation();
    await insertMessage(env.pool, { conversationId: convId, role: 'user', content: 'Q1' });
    const err = await env.pool
      .query(`INSERT INTO messages (conversation_id, seq, role, status) VALUES ($1, 1, 'user', 'completed')`, [convId])
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(err, ONE_INFLIGHT_ANSWER)).toBe(false);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it('answer lifecycle: start clears partial content, partial writes, single final update', async () => {
    const convId = await newConversation();
    const msg = await insertMessage(env.pool, { conversationId: convId, role: 'assistant' });

    // partial writes only apply while streaming
    expect(await writePartialContent(env.pool, msg.id, 'early')).toBe(false);

    const started = await startAnswer(env.pool, msg.id);
    expect(started).toMatchObject({ status: 'streaming', attempts: 1, content: '' });
    expect(await writePartialContent(env.pool, msg.id, 'The hybrid')).toBe(true);

    // a stalled rerun starts from empty content again
    const rerun = await startAnswer(env.pool, msg.id);
    expect(rerun).toMatchObject({ status: 'streaming', attempts: 2, content: '' });

    const citations = [{ quote: 'The hybrid prototype answered 41 questions.', startOffset: 11, endOffset: 54 }];
    expect(
      await completeAnswer(env.pool, msg.id, {
        content: 'It answered 41.',
        answerable: true,
        citations,
        retrieval: { mode: 'full' },
        finishReason: 'end_turn',
        model: 'fake',
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
    ).toBe(true);

    const done = await getMessage(env.pool, msg.id);
    expect(done).toMatchObject({
      status: 'completed',
      content: 'It answered 41.',
      answerable: true,
      citations,
      retrieval: { mode: 'full' },
      finishReason: 'end_turn',
      model: 'fake',
      usage: { input_tokens: 10, output_tokens: 3 },
      attempts: 2,
    });
    expect(done?.completedAt).toBeInstanceOf(Date);

    // terminal rows are never reopened or overwritten
    expect(await startAnswer(env.pool, msg.id)).toBeNull();
    expect(await failAnswer(env.pool, msg.id, 'stalled', 'x')).toBe(false);
    expect(await writePartialContent(env.pool, msg.id, 'late')).toBe(false);
    expect((await getMessage(env.pool, msg.id))?.status).toBe('completed');
    expect(await getMessage(env.pool, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
