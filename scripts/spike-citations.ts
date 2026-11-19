/**
 * Throwaway exploration: confirm the Citations API shapes for custom-content documents
 * before writing src/domain/citations.ts. Chunks the sample doc, sends it packaged two ways, asks an
 * answerable and an unanswerable question, and dumps the raw `finalMessage()` plus the stream event
 * types to docs/notes/spike-output/. Findings are written up in docs/notes/citations-spike.md.
 *
 * Every request is built by the production path, `toAnthropicParams(buildRequest(...))`: same system prompt,
 * documents, user text, `max_tokens` (`MAX_ANSWER_TOKENS` + thinking headroom) and `output_config.effort`.
 * The `single` packaging and the `between_tools` run are extra variants on top of that body.
 *
 *   pnpm spike            (needs ANTHROPIC_API_KEY; the repo-root env file is loaded if present)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { ConfigError, loadConfig } from '../src/config.js';
import { chunkDocument, type Passage } from '../src/domain/chunking.js';
import { hasNotInDocumentMarker, NOT_IN_DOCUMENT_MARKER } from '../src/domain/citations.js';
import { toAnthropicParams } from '../src/llm/anthropic.js';
import { buildRequest, type PromptPassage } from '../src/llm/prompt.js';
import type { AnswerRequest, RequestDocument } from '../src/llm/types.js';
import { loadEnvFile } from '../src/loadEnv.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT_DIR = `${ROOT}docs/notes/spike-output/`;
const DOCUMENT_TITLE = 'Harbor Archive retrieval pilot';

const QUESTIONS = {
  answerable: 'How did keyword search compare with the hybrid prototype, and what did the team decide?',
  unanswerable: 'What was the total budget of the pilot, in dollars?',
} as const;

type Packaging = 'per-passage' | 'single';

/** `per-passage` is what production sends; `single` (all sentences in one document) is the comparison. */
function requestFor(content: string, passages: Passage[], packaging: Packaging, question: string): AnswerRequest {
  const sent: PromptPassage[] =
    packaging === 'single'
      ? [{ id: 'all', heading: null, sentences: passages.flatMap((p) => p.sentences) }]
      : passages.map((p) => ({ id: `p${p.ordinal}`, heading: p.heading, sentences: p.sentences }));
  return buildRequest({ documentTitle: DOCUMENT_TITLE, content, passages: sent, history: [], question });
}

type Check = {
  documentIndex: number;
  startBlock: number;
  endBlock: number;
  inRange: boolean;
  citedTextEqualsConcat: boolean;
  citedTextEqualsSpaceJoin: boolean;
  offsets: [number, number] | null;
  sliceStartsWithFirstBlock: boolean;
};

function checkCitation(c: Anthropic.CitationContentBlockLocation, docs: RequestDocument[], content: string): Check {
  const doc = docs[c.document_index];
  const inRange =
    doc !== undefined && c.start_block_index >= 0 && c.end_block_index > c.start_block_index && c.end_block_index <= doc.blocks.length;
  const blocks = inRange ? doc.blocks.slice(c.start_block_index, c.end_block_index) : [];
  const first = inRange ? doc.sentences[c.start_block_index] : undefined;
  const last = inRange ? doc.sentences[c.end_block_index - 1] : undefined;
  const offsets: [number, number] | null = first && last ? [first.start, last.end] : null;
  return {
    documentIndex: c.document_index,
    startBlock: c.start_block_index,
    endBlock: c.end_block_index,
    inRange,
    citedTextEqualsConcat: inRange && c.cited_text === blocks.join(''),
    citedTextEqualsSpaceJoin: inRange && c.cited_text === blocks.join(' '),
    offsets,
    sliceStartsWithFirstBlock: offsets !== null && content.slice(offsets[0], offsets[1]).startsWith(blocks[0] ?? '\u0000'),
  };
}

async function run(
  client: Anthropic,
  model: string,
  maxAnswerTokens: number,
  req: AnswerRequest,
  thinking: Anthropic.ThinkingConfigParam | undefined,
) {
  const params: Anthropic.MessageStreamParams = {
    ...toAnthropicParams(req, { model, maxAnswerTokens }),
    ...(thinking ? { thinking } : {}),
  };
  const started = Date.now();
  let firstTextMs: number | null = null;
  const eventTypes: Record<string, number> = {};
  const stream = client.messages.stream(params, { timeout: 90_000 });
  for await (const event of stream) {
    const key = event.type === 'content_block_delta' ? `content_block_delta:${event.delta.type}` : event.type;
    eventTypes[key] = (eventTypes[key] ?? 0) + 1;
    if (firstTextMs === null && event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      firstTextMs = Date.now() - started;
    }
  }
  const message = await stream.finalMessage();
  const sentParams = { max_tokens: params.max_tokens, output_config: params.output_config, thinking: params.thinking ?? 'omitted (adaptive)' };
  return { message, eventTypes, firstTextMs, totalMs: Date.now() - started, sentParams };
}

async function main(): Promise<void> {
  loadEnvFile();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  if (config.modelProvider !== 'anthropic' || !config.anthropicApiKey) {
    console.error('spike needs MODEL_PROVIDER=anthropic and ANTHROPIC_API_KEY');
    process.exit(2);
  }
  const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 });
  const content = readFileSync(`${ROOT}samples/harbor-archive.md`, 'utf8');
  const passages = chunkDocument(content, 'markdown', { passageTokens: config.passageTokens });
  mkdirSync(OUT_DIR, { recursive: true });

  const runs: { name: string; packaging: Packaging; q: keyof typeof QUESTIONS; thinking?: Anthropic.ThinkingConfigParam }[] = [
    { name: 'per-passage-answerable', packaging: 'per-passage', q: 'answerable' },
    { name: 'per-passage-unanswerable', packaging: 'per-passage', q: 'unanswerable' },
    { name: 'single-answerable', packaging: 'single', q: 'answerable' },
    { name: 'single-unanswerable', packaging: 'single', q: 'unanswerable' },
    // Production request plus `thinking: between_tools` (thinking off), for a latency/quality comparison.
    { name: 'per-passage-answerable-between-tools', packaging: 'per-passage', q: 'answerable', thinking: { type: 'between_tools' } },
  ];

  const summary: unknown[] = [];
  for (const r of runs) {
    const req = requestFor(content, passages, r.packaging, QUESTIONS[r.q]);
    const docs = req.documents;
    try {
      const { message, eventTypes, firstTextMs, totalMs, sentParams } = await run(
        client,
        config.anthropicModel,
        config.maxAnswerTokens,
        req,
        r.thinking,
      );
      const checks: Check[] = [];
      for (const block of message.content) {
        if (block.type !== 'text') continue;
        for (const c of block.citations ?? []) {
          if (c.type === 'content_block_location') checks.push(checkCitation(c, docs, content));
        }
      }
      const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const { id: _id, ...rest } = message; // drop the message id; nothing else in the body is sensitive
      writeFileSync(
        `${OUT_DIR}${r.name}.json`,
        `${JSON.stringify(
          {
            question: QUESTIONS[r.q],
            packaging: r.packaging,
            request: sentParams,
            sent: docs.map((d, i) => ({ documentIndex: i, title: d.title, blockCount: d.blocks.length })),
            eventTypes,
            firstTextMs,
            totalMs,
            checks,
            finalMessage: rest,
          },
          null,
          2,
        )}\n`,
      );
      const row = {
        run: r.name,
        model: message.model,
        stop: message.stop_reason,
        maxTokens: sentParams.max_tokens,
        blocks: message.content.map((b) => b.type).join(','),
        citations: checks.length,
        allInRange: checks.every((c) => c.inRange),
        allConcat: checks.every((c) => c.citedTextEqualsConcat),
        multiBlock: checks.filter((c) => c.endBlock - c.startBlock > 1).length,
        // Marker adherence: `notInDocument` is what the service accepts, `markerExact` is the instructed format.
        notInDocument: hasNotInDocumentMarker(text, false),
        markerExact: text.trimStart().startsWith(NOT_IN_DOCUMENT_MARKER),
        firstTextMs,
        totalMs,
        inTok: message.usage.input_tokens,
        outTok: message.usage.output_tokens,
      };
      summary.push(row);
      console.log(JSON.stringify(row));
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const row = { run: r.name, error: err instanceof Error ? err.constructor.name : 'unknown', status, message: err instanceof Error ? err.message : String(err) };
      summary.push(row);
      console.log(JSON.stringify(row));
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        console.error('authentication failed; stopping');
        process.exit(3);
      }
    }
  }
  writeFileSync(`${OUT_DIR}summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err: unknown) => {
  console.error('spike failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
