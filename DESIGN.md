# Curie — design

> Skeleton; sections fill in as decisions are made during implementation.

## Assumptions

## Architecture

## Data model
- Four tables (`documents`, `passages`, `conversations`, `messages`) in one idempotent SQL file (`migrations/001_init.sql`, all `IF NOT EXISTS`). `migrate.ts` re-executes every file under a Postgres advisory lock, so there is no migrations table to drift and concurrent runs (compose `migrate`, test runs) serialize. Trade-off: later schema *changes* need `ALTER ... IF NOT EXISTS`-style statements; fine for this scope.
- `documents.content` is stored verbatim and never mutated; `utf16_length` is computed in JS so every offset is a JS string index. Sentence spans live in `passages.sentences` (jsonb) and are sliced only in JS.
- `passages.tsv` is a stored generated column (`to_tsvector('english', heading || text)`) with a GIN index: search terms are stemmed once at write time, never re-stemmed.
- `one_inflight_answer` is a partial unique index (one assistant message in `pending`/`streaming` per conversation): the database, not application code, enforces "one answer at a time"; the API maps that 23505 to 409 `answer_in_progress`. Message `seq` is allocated as `max(seq)+1` under `SELECT ... FOR UPDATE` on the conversation row.
- Repositories are plain functions taking a `Queryable` (pool or transaction client) plus a `withTx` helper; status transitions are guarded in SQL (`WHERE status IN (...)`) so a stale job rerun can never reopen a terminal row.

## Document preparation (chunking)

## Retrieval

## Grounding and citations

## Answer delivery

## Failure handling

## Alternatives considered

## Implementation plan and time log

## Complete vs remaining

## Verification

## AI use

## Access control

## Scaling to many documents (optional)
