# Curie — agent rules

Rules given to the coding agents that implement this repo. The plan lives in `docs/plans/`.

## Stack
- Node 22, TypeScript (ESM, `module: nodenext` — relative imports use `.js` extensions), pnpm.
- Fastify (HTTP), BullMQ + ioredis (jobs), PostgreSQL via `pg` with raw SQL (no ORM), zod (config/validation), pino (logs), `@anthropic-ai/sdk` (model), vitest (tests).
- TypeScript 7 (native `tsc`) is used only for `typecheck`/`build`; tsx and vitest transpile on their own.
- Dependency build scripts are allow-listed in `pnpm-workspace.yaml` (`allowBuilds`: esbuild, msgpackr-extract); add new ones there deliberately.
- Local scripts auto-load the repo-root dotenv file if present: entrypoints and `scripts/*.ts` (and the `src/db/migrate.ts` CLI) call `loadEnvFile()` from `src/loadEnv.ts` (Node's built-in `process.loadEnvFile`, never overrides variables already set, never throws). Never import it from `src/config.ts` or from tests — tests stay hermetic. Package scripts carry no env-file flags.
- Local services: `docker compose up -d postgres redis` (host ports 54329 / 63799). The `curie_test` database is created on first volume init by `docker/postgres-init.sql`.

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

## Workflow
- One plan task per agent run; complete all its checkboxes, then stop.
- Every task adds or updates tests (success and error cases). Pure domain logic is written test-first.
- `pnpm test` and `pnpm typecheck` must pass before committing. Integration tests need the compose services running.
- Mark plan checkboxes as you finish them; record scope changes in the plan (➕ new, ⚠️ blocker).
- Never claim verification you did not run; say what was skipped and why.
- No secrets in the repo: `.env` is gitignored, `.env.example` has no credentials.
- Add a bullet to `DESIGN.md` for each design decision as it is made.
