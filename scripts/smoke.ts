/**
 * Live smoke run against the configured model provider, without the HTTP stack: chunks
 * `samples/harbor-archive.md` with the real chunker, builds each request with `buildRequest`, calls
 * `createAnswerModel(config).generate`, and verifies the reply with `resolveCitations` — the same path the
 * generate-answer processor runs. Three questions (`SMOKE_QUESTIONS` in `scripts/smoke-check.ts`): one answerable,
 * one not in the document, and a follow-up that is only answerable through history.
 *
 *   pnpm smoke     # MODEL_PROVIDER=gemini + GEMINI_API_KEY (or anthropic + ANTHROPIC_API_KEY) in the env file
 *
 * One request per question, sequential, no retries (free-tier quota). Exit codes: 0 all expectations met, 1 an
 * expectation failed (or the model refused), 2 configuration or model/network error (it stops at the first one).
 * Never prints the configuration, so never the API key.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, type Config } from '../src/config.js';
import { chunkDocument } from '../src/domain/chunking.js';
import { resolveCitations } from '../src/domain/citations.js';
import { classifyError } from '../src/llm/errors.js';
import { createAnswerModel } from '../src/llm/index.js';
import { buildRequest, type PromptMessage } from '../src/llm/prompt.js';
import { loadEnvFile } from '../src/loadEnv.js';
import { checkSmokeAnswer, FALLBACK_KEYWORD_ANSWER, formatSmokeRow, SMOKE_QUESTIONS, type SmokeRow } from './smoke-check.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOCUMENT_TITLE = 'Harbor Archive retrieval pilot';

class HarnessError extends Error {}

function modelIdOf(config: Config): string {
  return config.modelProvider === 'gemini' ? config.geminiModel : config.anthropicModel;
}

async function main(): Promise<number> {
  loadEnvFile();
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) throw new HarnessError(err.message);
    throw err;
  }
  if (config.modelProvider === 'fake') {
    throw new HarnessError('MODEL_PROVIDER=fake: the smoke run needs a real provider (gemini or anthropic) and its key');
  }

  const content = readFileSync(`${ROOT}samples/harbor-archive.md`, 'utf8');
  const passages = chunkDocument(content, 'markdown', { passageTokens: config.passageTokens }).map((p) => ({ id: `p${p.ordinal}`, ...p }));
  const model = createAnswerModel(config);
  console.log(`smoke: provider ${config.modelProvider}, model ${modelIdOf(config)}, ${passages.length} passages, ${SMOKE_QUESTIONS.length} questions\n`);

  const rows: SmokeRow[] = [];
  let previous: { question: string; answer: string | null } | null = null;
  for (const q of SMOKE_QUESTIONS) {
    const history: PromptMessage[] =
      q.followUp && previous
        ? [
            { role: 'user', content: previous.question, status: 'completed' },
            { role: 'assistant', content: previous.answer ?? FALLBACK_KEYWORD_ANSWER, status: 'completed' },
          ]
        : [];
    const request = buildRequest({ documentTitle: DOCUMENT_TITLE, content, passages, history, question: q.question });
    const started = Date.now();
    let row: SmokeRow;
    try {
      const raw = await model.generate(request, () => {}, new AbortController().signal);
      const resolved = resolveCitations(raw, request.documents, content);
      row = {
        id: q.id,
        question: q.question,
        resolved,
        stopReason: raw.stopReason,
        model: raw.model,
        usage: raw.usage,
        seconds: (Date.now() - started) / 1000,
        check: checkSmokeAnswer(resolved, q.expect, content),
      };
    } catch (err) {
      const classified = classifyError(err);
      if (classified.code !== 'model_refused') {
        throw new HarnessError(`[${q.id}] ${classified.code} (retryable: ${classified.retryable}): ${classified.message}`);
      }
      console.log(`FAIL [${q.id}] ${q.question}\n  model_refused: ${classified.message}\n`);
      rows.push({
        id: q.id,
        question: q.question,
        resolved: { answerable: false, text: '', citations: [], dropped: [], notFoundReason: null, rawText: '' },
        stopReason: 'refusal',
        model: modelIdOf(config),
        usage: null,
        seconds: (Date.now() - started) / 1000,
        check: { pass: false, reason: classified.message },
      });
      previous = { question: q.question, answer: null };
      continue;
    }
    rows.push(row);
    console.log(`${formatSmokeRow(row)}\n`);
    previous = { question: q.question, answer: row.resolved.answerable ? row.resolved.text : null };
  }

  const passed = rows.filter((r) => r.check.pass).length;
  console.log(`${passed}/${rows.length} passed`);
  return passed === rows.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`smoke: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
