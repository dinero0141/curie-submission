# Curie — design

> Skeleton; sections fill in as decisions are made during implementation.

## Assumptions

## Architecture
- Configuration comes only from the process environment (`loadConfig(env)` is pure and unit-tested). For local runs, entrypoints and scripts first call `loadEnvFile()` (`src/loadEnv.ts`), which uses Node's built-in `process.loadEnvFile` when the repo-root dotenv file exists: no `dotenv` dependency, no `--env-file` flags in package scripts, shell variables always win (guarded by a snapshot, not only Node's default), and a missing or unreadable file is not an error. Tests never call it, so a developer's local file cannot change test results.

## Data model
- Four tables (`documents`, `passages`, `conversations`, `messages`) in one idempotent SQL file (`migrations/001_init.sql`, all `IF NOT EXISTS`). `migrate.ts` re-executes every file under a Postgres advisory lock, so there is no migrations table to drift and concurrent runs (compose `migrate`, test runs) serialize. Trade-off: later schema *changes* need `ALTER ... IF NOT EXISTS`-style statements; fine for this scope.
- `documents.content` is stored verbatim and never mutated; `utf16_length` is computed in JS so every offset is a JS string index. Sentence spans live in `passages.sentences` (jsonb) and are sliced only in JS.
- `passages.tsv` is a stored generated column (`to_tsvector('english', heading || text)`) with a GIN index: search terms are stemmed once at write time, never re-stemmed.
- `one_inflight_answer` is a partial unique index (one assistant message in `pending`/`streaming` per conversation): the database, not application code, enforces "one answer at a time"; the API maps that 23505 to 409 `answer_in_progress`. Message `seq` is allocated as `max(seq)+1` under `SELECT ... FOR UPDATE` on the conversation row.
- Repositories are plain functions taking a `Queryable` (pool or transaction client) plus a `withTx` helper; status transitions are guarded in SQL (`WHERE status IN (...)`) so a stale job rerun can never reopen a terminal row.

## Document preparation (chunking)
- Pipeline (`src/domain/chunking.ts`, pure, no I/O): content → blocks → sentences → passages. Every offset is a UTF-16 index into the untouched `documents.content`; each sentence span is trimmed to start and end on a non-whitespace char, so `content.slice(start, end)` *is* the sentence and is never empty. These sentence spans are the unit we send to Claude as citation blocks, so quotes are exact slices of the stored document by construction.
- Markdown uses a small hand-rolled line scanner instead of a CommonMark parser. It handles ATX and setext headings, fenced code (one block per non-blank line, `#` inside a fence is not a heading), block quotes, list items (one block each, task-list `[x]` stripped), table rows (one block per row) and thematic breaks/table separators (syntax only). Markers are kept out of sentence boundaries by segmenting a **same-length masked copy** (markers → spaces), so no offset mapping is needed. Heading lines are never sentences. Inline markup (`**bold**`, links) stays in the sentence text. A parser AST would give us node positions too, but we would still need the masking and trimming logic on top, so the scanner is less code to own.
- Plain text: blank-line paragraphs, nothing masked; every non-whitespace character lands in exactly one sentence (tested).
- Sentences come from `Intl.Segmenter('en', {granularity: 'sentence'})` (built into Node, handles decimals like `0.7`, CJK `。`, emoji). Line breaks inside a block count as soft wraps (UAX #29 would otherwise break after every LF). A sentence longer than the passage budget (`PASSAGE_TOKENS × 4` chars) is hard-split at whitespace (at the limit if there is none, never inside a surrogate pair).
- Passages: greedy packing of whole sentences up to `PASSAGE_TOKENS` (estimate = `ceil(chars / 4)`), never across a heading (each heading starts a new section, even if it repeats a name), always ≥ 1 sentence, so no document sent to the model can have zero blocks. `passage.heading` is the nearest heading's text, not the full path. A document with no sentence left (empty, whitespace, headings/fences only) fails permanently with `empty_after_parse`. Above an optional `maxPassages` it fails with `too_many_passages`. Speed: about 160 ms for a 5 MB markdown file.
- Known limitations: abbreviation splits ("e.g. foo") can cut a sentence in two. This does no harm here because a citation may span consecutive blocks, so the quote still covers both pieces. Not supported: lazy-continuation edge cases, nested-quote nesting levels, indented code blocks, HTML blocks, YAML front matter (it becomes a setext heading plus text). The token estimate undercounts CJK, where one char is about one token. A real tokenizer would be the next step if CJK papers matter.

## Retrieval

## Grounding and citations
- Citations API shapes (custom-content documents, `content_block_location` with exclusive `end_block_index`, `citations_delta` folded into `finalMessage()`) come from the claude-api skill and the `@anthropic-ai/sdk` 1.10.0 types. They are **assumed, not observed live**: the build had no API key. `docs/notes/citations-spike.md` lists each fact with its source. `pnpm spike` is the check still to run. The code does not trust these shapes: indices are range-checked and every quote is rebuilt from `content.slice` and verified block by block, so a wrong assumption drops citations rather than showing wrong quotes.
- Packaging: **one custom-content document per passage** (title = heading, one text block per sentence). Passages sent in `ranked` mode are not adjacent, and a single document would let a citation run across a gap and quote text we never sent. Per passage, a block range is always a contiguous slice of the source, and `document_index` maps straight to a passage. Documents go only in the final user message (history is plain text), so `document_index` has one meaning whichever way the API counts, and the 2026-10-21 rules against citations on user text and documents in assistant turns cannot be hit.
- Mapping and verification (`src/domain/citations.ts`, pure): `document_index` → the passage sent at that position, block range `[start, end)` → `[sentences[start].start, sentences[end-1].end)`, quote = `content.slice` of that range. Because the shapes are unverified, the mapping is defensive: only `content_block_location` is accepted; non-integer or out-of-range document/block indices are dropped; each cited block must equal the text we sent for it (itself `content.slice(span)`); and `cited_text` must equal the cited blocks joined, compared with all whitespace removed (the separator is undocumented). `cited_text` is a cross-check only, never the quote, and a citation without it is dropped. So a wrong assumption about `cited_text` joining or index semantics (an inclusive or 1-based `end_block_index` would make `cited_text` cover other blocks) produces a dropped citation, never a wrong quote. Every drop is returned with a reason for `retrieval.debug`.
- Grounded-or-not rule: an answer is `answerable=false` when the reply starts with `NOT_IN_DOCUMENT:` (after leading whitespace) or no citation survives verification. The displayed text is then a fixed not-found message, citations are stripped, and the raw model text is kept for debugging. The marker elsewhere in a cited reply does not count. Each surviving citation carries `answerStart/answerEnd` into the concatenated answer text blocks, so a client can link each quote to the claim it supports; adjacent repeats of the same quote are merged into one widened range.
- Limitation: inside an answerable reply, sentences the model left uncited are not flagged or removed. A client sees which parts carry citations through `answerStart/answerEnd`, but the backend does not check that every claim is covered.

## Answer delivery

## Failure handling

## Alternatives considered

## Implementation plan and time log

## Complete vs remaining

## Verification

## AI use

## Access control

## Scaling to many documents (optional)
