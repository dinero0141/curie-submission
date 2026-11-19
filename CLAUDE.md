# Curie — agent rules

Rules given to the coding agents that implement this repo. The plan lives in `docs/plans/`.

## Stack
- Node 22, TypeScript (ESM, `module: nodenext` — relative imports use `.js` extensions), pnpm.
- Fastify (HTTP), BullMQ + ioredis (jobs), PostgreSQL via `pg` with raw SQL (no ORM), zod (config/validation), pino (logs), `@anthropic-ai/sdk` (model), vitest (tests).
- TypeScript 7 (native `tsc`) is used only for `typecheck`/`build`; tsx and vitest transpile on their own.
- Dependency build scripts are allow-listed in `pnpm-workspace.yaml` (`allowBuilds`: esbuild, msgpackr-extract); add new ones there deliberately.
- Local scripts auto-load the repo-root dotenv file if present: entrypoints and `scripts/*.ts` (and the `src/db/migrate.ts` CLI) call `loadEnvFile()` from `src/loadEnv.ts` (Node's built-in `process.loadEnvFile`, never overrides variables already set, never throws). Never import it from `src/config.ts` or from tests — tests stay hermetic. Package scripts carry no env-file flags.
- Local services: `docker compose up -d postgres redis` (host ports 54329 / 63799). The `curie_test` database is created on first volume init by `docker/postgres-init.sql`.
- Full stack: `docker compose up --build` (migrate → api on :3000 + worker, one image). `MODEL_PROVIDER` defaults to `fake` in compose (shell > dotenv > `fake`). Stop the app containers afterwards (`docker compose rm -sf api worker migrate`) and `docker image prune -f`; disk is tight.

## Commands
- `pnpm typecheck`, `pnpm test` (unit + integration; needs `docker compose up -d postgres redis`), `pnpm test:unit` (no services).
- One file or test: `pnpm vitest run test/integration/failures.test.ts` (add `-t "<name>"`).
- `pnpm migrate`, `pnpm dev:api` / `pnpm dev:worker` (tsx watch), `pnpm build` (tsc to `dist/`).

## Debugging
- A "not found" or odd answer: read `messages.retrieval.debug` (via `GET /messages/:id`): `notFoundReason`, `rawText` (model text when not answerable), `dropped[]` (each dropped citation with its reason), `query.text` / `query.tsquery` (ranked mode). `retrieval.mode`, `passageOrdinals` and `hits` say what the model saw.
- A `citations_unverified` failure has no `retrieval`; the worker's warn log (`answer has no verified citation`) lists each dropped citation's reason, type and keys. The same reason on every answer means a Citations shape assumption is wrong (`docs/notes/citations-spike.md`).
- `LOG_LEVEL=debug` for both processes; the worker logs each reconciler repair (`reconciler repaired rows`) and every internal error with its original text (the row only stores a generic message).
- Point tests elsewhere with `TEST_DATABASE_URL` / `TEST_REDIS_URL`. If `curie_test` is missing, the Postgres volume predates `docker/postgres-init.sql`: `docker compose down -v` and start again.

## Invariants
- Offsets are UTF-16 code units (JS string indices), half-open `[start, end)`, into the original `documents.content`. Content is never mutated after insert.
- Slice text only in JS (`content.slice(start, end)`), never in SQL (`substring` counts code points).
- Quotations come from the model's Citations output mapped through our stored sentence spans and are re-verified against `content.slice`; never trust model-written quote text.
- Slow or failure-prone work (chunking, model calls) runs in BullMQ workers, never in the request path.
- The job processor owns terminal DB state (writes `failed` itself on permanent errors or the final attempt); `worker.on('failed')` is only a logging backstop.
- Error responses use the envelope `{ "error": { "code", "message" } }`.

## Database
- Schema changes go in `migrations/*.sql` and must stay idempotent (`IF NOT EXISTS`); `pnpm migrate` re-runs every file.
- Repositories in `src/db/` are plain functions taking a `Queryable`; use `withTx(pool, fn)` for multi-statement writes. Map unique violations with `isUniqueViolation(err, constraintName)`.
- Integration tests call `useIntegrationEnv()` from `test/integration/setup.ts` (pool on `curie_test`, TRUNCATE per file, unique BullMQ prefix). `globalSetup.ts` fails fast if Postgres/Redis are down and migrates once.

## Patterns (learned while building)
- Final-state rule: a processor's `catch` writes terminal `failed` itself when the error is permanent or `isFinalAttempt(job)` (`job.attemptsMade + 1 >= job.opts.attempts`; `attemptsMade` is 0 on the first run on BullMQ 6.7.7, pinned by tests). Permanent errors are rethrown as `UnrecoverableError`. A retryable answer failure before the last attempt goes back to `pending` with content cleared (`requeueAnswer`).
- Request-path enqueues are bounded (`settlesWithin`, 2 s). The row is written first and is the source of truth; a slow or failed enqueue still returns 202 and the reconciler enqueues stale rows later. Job id = row id, so re-enqueueing is safe.
- Repository status writes are guarded (`WHERE status IN (...)`) and return whether they applied; never write a terminal state unconditionally.
- Model errors go through `classifyError` (`src/llm/errors.ts`) only. Tests build real SDK errors with `APIError.generate(...)` and drive `AnthropicModel` through the real SDK client with a stubbed `fetch`, never a hand-rolled mock of the client.
- Regexes run on whole lines of untrusted input: never put two quantifiers that can match the same characters next to each other (e.g. `[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$` is quadratic); parse such tails by hand. `test/unit/chunking.test.ts` has a ~1 MB-line time bound.
- Use `FakeModel` in every test: `.script({match, reply, errors, latch, midStreamErrors})`, `fakeCitation(req, docIndex, start, end?)`, `.requests` to assert what was sent (recorded by default; the demo worker uses `{ record: false }`), `latch` + `.release()` to hold an answer mid-stream. Its citations go through the same `resolveCitations` checks as real ones.
- Timing-dependent behaviour takes options (`staleAfterMs`, `intervalMs`, `partialWriteMs`, backoff overrides in `createQueues`) so tests age rows or shorten delays instead of sleeping.
- Full-text search: stem once. The OR query re-parses the `english` tsquery with the `simple` config; never run user text through `english` twice. Keep search SQL in `src/db/search.ts` and the selection policy pure in `src/domain/retrieval.ts`.
- The Citations shapes are assumptions recorded in `docs/notes/citations-spike.md`. If code depends on a new shape detail, add it there with its source and status, and keep `resolveCitations` defensive (drop, never repair).
- Provider adapters map their output into `RawAnswer` blocks with `content_block_location` citations (Gemini: `passage` → `document_index`, inclusive `lastSentence` → exclusive `end_block_index`, model quote → `cited_text`), passing values through untouched, so `resolveCitations` stays the single verifier. Gemini errors are `GeminiApiError` / `GeminiConnectionError` (classified in `classifyError`); test `GeminiModel` through a stubbed `fetch`. Its API facts live in `docs/notes/gemini-notes.md` (record new ones there with source and status).
- Docs: JSON examples are captured from the running stack (`docs/notes/manual-checks.md`); label anything that is only the code/test shape. Link README → DESIGN → `docs/API.md` → `docs/notes/*` instead of repeating content.

## Agent environment
- A user hook blocks any Bash command whose text contains the dotenv file name, and a permission rule blocks reading or writing dotenv files. Do not work around either; the app loads the file itself (`src/loadEnv.ts`). `.env.example` is maintained by the human.
- The session guard rejects a Bash command that uses the word `eval` as a command word; run the eval CLI as `pnpm exec tsx scripts/eval.ts`.
- Disk is tight: after any image build run `docker image prune -f` and remove app containers.
- No API key in this build: anything that needs the real API is marked in the plan as `⚠️ not run — no API key (keyless run)` with what remains.

## Workflow
- One plan task per agent run; complete all its checkboxes, then stop.
- Every task adds or updates tests (success and error cases). Pure domain logic is written test-first.
- `pnpm test` and `pnpm typecheck` must pass before committing. Integration tests need the compose services running.
- Mark plan checkboxes as you finish them; record scope changes in the plan (➕ new, ⚠️ blocker).
- Never claim verification you did not run; say what was skipped and why.
- No secrets in the repo: `.env` is gitignored, `.env.example` has no credentials.
- Add a bullet to `DESIGN.md` for each design decision as it is made.
