// Ranked retrieval against real Postgres full-text search: the OR tsquery (src/db/search.ts), the selection
// policy (src/domain/retrieval.ts) and the generate-answer processor recording what it sent. FakeModel only
// (keyless run); the ranked path is not exercised against the live model.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { insertConversation } from '../../src/db/conversations.js';
import { insertDocument } from '../../src/db/documents.js';
import { getMessage, insertMessage } from '../../src/db/messages.js';
import { listPassages } from '../../src/db/passages.js';
import { listPassageIndex, searchPassages } from '../../src/db/search.js';
import { NOT_FOUND_IN_SEARCHED_MESSAGE, NOT_FOUND_MESSAGE } from '../../src/domain/citations.js';
import { RANKED_TOP_K, fitsFullContext, selectPassages } from '../../src/domain/retrieval.js';
import { createGenerateAnswerProcessor } from '../../src/jobs/generateAnswer.js';
import { createPrepareDocumentProcessor } from '../../src/jobs/prepareDocument.js';
import { FakeModel } from '../../src/llm/fake.js';
import { useIntegrationEnv } from './setup.js';

const env = useIntegrationEnv();
const SAMPLE = readFileSync(fileURLToPath(new URL('../../samples/harbor-archive.md', import.meta.url)), 'utf8');

/** Budget small enough that the synthetic document (~30 passages) is "large". */
const BUDGET = 1_500;
const FILLER_SECTIONS = 30;
const NEEDLE_AFTER = 15; // the needle sections sit in the middle of the filler

// Filler vocabulary is disjoint from every term the questions below search for.
function fillerSection(i: number): string {
  const s = [
    `Tide tables for week ${i} were copied into the ledger by the harbour clerk.`,
    'The ferry timetable shifted after the storm, and the pier office posted a notice.',
    'Volunteers sorted postcards by decade and boxed them for the attic shelves.',
    'Harbour cats slept near the boiler room while the kettle whistled.',
  ];
  return `## Harbour diary ${i}\n\n${Array(4).fill(s.join(' ')).join('\n\n')}\n`;
}

const LENS_SECTION =
  '## Lens survey\n\nSeventeen universities lent lenses to the survey. Each lens was weighed and photographed.\n';
const LOGBOOK_SECTION =
  '## Logbook checks\n\nCross-validation of the logbooks took nine days. The state-of-the-art scanner failed twice.\n';

function largeDocument(): string {
  const parts = ['# Synthetic harbour archive\n'];
  for (let i = 0; i < FILLER_SECTIONS; i++) {
    parts.push(fillerSection(i));
    if (i === NEEDLE_AFTER) parts.push(LENS_SECTION, LOGBOOK_SECTION);
  }
  return parts.join('\n');
}

async function prepared(title: string, content: string): Promise<string> {
  const doc = await insertDocument(env.pool, { title, format: 'markdown', content });
  const prepare = createPrepareDocumentProcessor({ pool: env.pool, passageTokens: 400 });
  await prepare({ id: doc.id, data: { documentId: doc.id }, attemptsMade: 0, opts: { attempts: 1 } });
  return doc.id;
}

let largeId: string;
let lensOrdinal: number;
let logbookOrdinal: number;
let passageCount: number;

beforeAll(async () => {
  largeId = await prepared('Large', largeDocument());
  const rows = await listPassages(env.pool, largeId);
  passageCount = rows.length;
  lensOrdinal = rows.find((p) => p.heading === 'Lens survey')!.ordinal;
  logbookOrdinal = rows.find((p) => p.heading === 'Logbook checks')!.ordinal;
  // Preconditions the tests rely on: over budget, needles are their own passages away from both ends.
  expect(fitsFullContext(await listPassageIndex(env.pool, largeId), { fullContextTokens: BUDGET })).toBe(false);
  expect(logbookOrdinal).toBe(lensOrdinal + 1);
  expect(lensOrdinal).toBeGreaterThan(2);
  expect(logbookOrdinal).toBeLessThan(passageCount - 2);
});

async function rankedFor(question: string) {
  const index = await listPassageIndex(env.pool, largeId);
  const search = await searchPassages(env.pool, largeId, question, RANKED_TOP_K);
  return { search, result: selectPassages(index, { fullContextTokens: BUDGET }, search.hits) };
}

describe('ranked retrieval over a large document', () => {
  it('finds the needle passage first and sends it with its neighbours, in document order', async () => {
    const { search, result } = await rankedFor('Which universities lent lenses?');
    expect(search.nodes).toBeGreaterThan(0);
    expect(search.hits[0]!.ordinal).toBe(lensOrdinal);
    expect(result.mode).toBe('ranked');
    const ordinals = result.passages.map((p) => p.ordinal);
    expect(ordinals).toEqual(expect.arrayContaining([lensOrdinal - 1, lensOrdinal, lensOrdinal + 1]));
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    expect(result.tokenEstimate).toBeLessThanOrEqual(BUDGET);
    expect(result.hits[0]).toMatchObject({ ordinal: lensOrdinal, rank: 1 });
    expect(result.hits[0]!.score).toBeGreaterThan(0);
  });

  it('matches a word whose stem would change if stemmed twice', async () => {
    // english: universities → univers; stemming 'univers' again gives 'univ', which the tsvector lacks.
    const doubleStemmed = await env.pool.query(
      `SELECT count(*)::int AS n FROM passages
        WHERE document_id = $1 AND tsv @@ to_tsquery('english', plainto_tsquery('english', 'universities')::text)`,
      [largeId],
    );
    expect(doubleStemmed.rows[0].n).toBe(0); // the trap the 'simple' re-parse avoids
    const { search } = await rankedFor('universities');
    expect(search.tsquery).toBe("'univers'");
    expect(search.hits.map((h) => h.ordinal)).toEqual([lensOrdinal]);
  });

  it('matches hyphenated terms, including one with stopword parts', async () => {
    const cross = await rankedFor('Who did the cross-validation?');
    expect(cross.search.hits[0]!.ordinal).toBe(logbookOrdinal);
    expect(cross.result.passages.map((p) => p.ordinal)).toContain(logbookOrdinal);

    // 'state-of-the-art' re-parsed by 'simple' becomes a phrase with 'of'/'the' that cannot match the english
    // tsvector; the separate 'state' | 'art' branches still find the passage.
    const sota = await rankedFor('state-of-the-art');
    expect(sota.search.tsquery).toContain("'state' | 'art'");
    expect(sota.search.hits.map((h) => h.ordinal)).toEqual([logbookOrdinal]);
  });

  it('ORs the terms: a question sharing one term with the passage still finds it', async () => {
    const { search } = await rankedFor('Did the scanner jam during the regatta?');
    expect(search.tsquery).toContain(' | ');
    expect(search.hits[0]!.ordinal).toBe(logbookOrdinal);
  });

  it('treats tsquery syntax in the question as plain text', async () => {
    const { search } = await rankedFor("universities & !(lens | ') <-> :*");
    expect(search.hits[0]!.ordinal).toBe(lensOrdinal);
  });

  it('falls back to leading passages for a stopword-only question', async () => {
    const { search, result } = await rankedFor('What was it?');
    expect(search).toEqual({ tsquery: '', nodes: 0, hits: [] });
    expect(result.mode).toBe('fallback');
    expect(result.passages[0]!.ordinal).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it('falls back when no passage contains any query term', async () => {
    const { search, result } = await rankedFor('photosynthesis');
    expect(search.nodes).toBe(1);
    expect(search.hits).toEqual([]);
    expect(result.mode).toBe('fallback');
  });

  it('only returns passages of the requested document', async () => {
    const otherId = await prepared('Other', LENS_SECTION);
    const { search } = await rankedFor('universities');
    expect(search.hits.map((h) => h.ordinal)).toEqual([lensOrdinal]);
    const other = await searchPassages(env.pool, otherId, 'universities', RANKED_TOP_K);
    expect(other.hits).toHaveLength(1);
    expect(other.hits[0]!.id).not.toBe(search.hits[0]!.id);
  });
});

describe('sample document', () => {
  it('fits the default FULL_CONTEXT_TOKENS and is sent whole', async () => {
    const sampleId = await prepared('Harbor Archive', SAMPLE);
    const { fullContextTokens } = loadConfig({ MODEL_PROVIDER: 'fake', DATABASE_URL: env.databaseUrl, REDIS_URL: env.redisUrl });
    const index = await listPassageIndex(env.pool, sampleId);
    expect(fitsFullContext(index, { fullContextTokens })).toBe(true);
    const r = selectPassages(index, { fullContextTokens });
    expect(r.mode).toBe('full');
    expect(r.passages.map((p) => p.ordinal)).toEqual([...index.keys()]);
  });
});

describe('generate-answer with ranked retrieval', () => {
  const fake = new FakeModel(); // default reply cites the first sentence of the first sent passage
  fake.script({ match: 'mention whales', reply: { text: 'NOT_IN_DOCUMENT: no whales.' } });

  async function answer(conversationId: string, question: string, fullContextTokens = BUDGET) {
    await insertMessage(env.pool, { conversationId, role: 'user', content: question });
    const assistant = await insertMessage(env.pool, { conversationId, role: 'assistant' });
    const processor = createGenerateAnswerProcessor({ pool: env.pool, model: fake, fullContextTokens });
    const messageId = assistant.id;
    await processor({ id: messageId, data: { messageId }, attemptsMade: 0, opts: { attempts: 1 } });
    return (await getMessage(env.pool, messageId))!;
  }

  it('sends only the ranked passages and records mode, passage ids and ranks', async () => {
    const conversation = await insertConversation(env.pool, largeId);
    const msg = await answer(conversation.id, 'Which universities lent lenses?');
    const rows = await listPassages(env.pool, largeId);
    const lens = rows.find((p) => p.ordinal === lensOrdinal)!;

    expect(msg.status).toBe('completed');
    const retrieval = msg.retrieval as Record<string, any>;
    expect(retrieval.mode).toBe('ranked');
    expect(retrieval.passageIds).toContain(lens.id);
    expect(retrieval.passageOrdinals).toEqual(
      retrieval.passageIds.map((id: string) => rows.find((p) => p.id === id)!.ordinal),
    );
    expect(retrieval.hits[0]).toEqual({ passageId: lens.id, ordinal: lensOrdinal, rank: 1, score: expect.any(Number) });
    expect(retrieval.documentTokens).toBeGreaterThan(BUDGET);
    expect(retrieval.tokenEstimate).toBeLessThanOrEqual(BUDGET);
    expect(retrieval.debug.query).toEqual({ text: 'Which universities lent lenses?', tsquery: expect.stringContaining("'univers'") });

    // The model saw exactly the recorded passages, in document order, and the quote is still verified.
    expect(fake.lastRequest!.documents.map((d) => d.passageId)).toEqual(retrieval.passageIds);
    const citations = msg.citations as { passageId: string; quote: string; startOffset: number; endOffset: number }[];
    expect(citations).toHaveLength(1);
    expect(retrieval.passageIds).toContain(citations[0]!.passageId);
  });

  it('keeps a follow-up ranked through the previous question’s terms', async () => {
    const conversation = await insertConversation(env.pool, largeId);
    await answer(conversation.id, 'Who did the cross-validation?');
    // "And how long did it take?" alone is nearly all stopwords; the previous question carries the terms.
    const msg = await answer(conversation.id, 'And how long did it take?');
    const retrieval = msg.retrieval as Record<string, any>;
    expect(retrieval.mode).toBe('ranked');
    expect(retrieval.hits[0].ordinal).toBe(logbookOrdinal);
    expect(retrieval.debug.query.text).toBe('And how long did it take?\nWho did the cross-validation?');
  });

  it('records fallback for a stopword-only first question', async () => {
    const conversation = await insertConversation(env.pool, largeId);
    const msg = await answer(conversation.id, 'What was it?');
    const retrieval = msg.retrieval as Record<string, any>;
    expect(retrieval).toMatchObject({ mode: 'fallback', hits: [], debug: { query: { tsquery: '' } } });
    expect(retrieval.passageOrdinals[0]).toBe(0);
  });

  it('records full mode with no search for a document within the budget', async () => {
    const conversation = await insertConversation(env.pool, largeId);
    const msg = await answer(conversation.id, 'Which universities lent lenses?', 1_000_000);
    const retrieval = msg.retrieval as Record<string, any>;
    expect(retrieval).toMatchObject({ mode: 'full', hits: [], debug: { query: null } });
    expect(retrieval.passageIds).toHaveLength(passageCount);
  });

  it('says only the searched parts lacked the answer when the model saw part of the document', async () => {
    const ranked = await answer((await insertConversation(env.pool, largeId)).id, 'Do the lenses mention whales?');
    expect(ranked).toMatchObject({ status: 'completed', answerable: false, content: NOT_FOUND_IN_SEARCHED_MESSAGE });
    expect((ranked.retrieval as Record<string, any>).mode).toBe('ranked');

    const full = await answer((await insertConversation(env.pool, largeId)).id, 'Do the lenses mention whales?', 1_000_000);
    expect(full).toMatchObject({ status: 'completed', answerable: false, content: NOT_FOUND_MESSAGE });
  });
});
