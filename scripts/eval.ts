/**
 * Live eval: drives the real HTTP API end to end with the questions in
 * `samples/eval-questions.json`. Uploads the sample document, waits until it is ready, runs every conversation
 * (turns after the first are follow-ups in the same conversation), checks each answer (`scripts/eval-check.ts`:
 * answerable expectation + expected substring in some citation quote + offsets slice the stored content),
 * prints a table and exits 1 if any answer fails, 2 if the harness itself fails (API down, document failed,
 * timeout).
 *
 *   docker compose up --build            # MODEL_PROVIDER=anthropic + ANTHROPIC_API_KEY in the env file
 *   pnpm eval [path/to/questions.json]   # EVAL_BASE_URL (default http://localhost:3000), EVAL_VERBOSE=1
 *
 * The model is whatever the server runs; the eval only talks HTTP. Against `MODEL_PROVIDER=fake` it exercises the
 * harness, not answer quality: the fake model cites the first sentence for every question, so content checks fail.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../src/loadEnv.js';
import { formatTable, parseEvalSuite } from './eval-check.js';
import { runEvalSuite } from './eval-runner.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

async function main(): Promise<number> {
  loadEnvFile();
  const baseUrl = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
  const suitePath = process.argv[2] ?? `${ROOT}samples/eval-questions.json`;
  const suite = parseEvalSuite(JSON.parse(readFileSync(suitePath, 'utf8')));
  const content = readFileSync(`${ROOT}${suite.document.path}`, 'utf8');
  const verbose = Boolean(process.env.EVAL_VERBOSE);

  console.log(`eval: ${baseUrl}, ${suite.conversations.flat().length} questions from ${suitePath}`);
  const { rows, models } = await runEvalSuite({
    baseUrl,
    suite,
    content,
    onAnswer: verbose
      ? (id, a) => console.log(`\n[${id}] ${a.status} mode=${a.retrieval?.mode} attempts=${a.attempts}\n${a.content}`)
      : undefined,
  });

  console.log(`\nmodel: ${models.join(', ') || 'unknown'}\n`);
  console.log(formatTable(rows));
  if (models.includes('fake')) {
    console.log('\nnote: the server runs MODEL_PROVIDER=fake; this run checks the harness, not answer quality.');
  }
  return rows.every((r) => r.pass) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`eval harness error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
