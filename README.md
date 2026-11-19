# Curie — chat with a document

Backend for asking questions about one Markdown or plain-text document. Documents are prepared in a background
worker; answers come only from the selected document, with quotations that are verified against the stored text and
located by character offsets, or an explicit "not in this document" result. Clients poll for answers and see partial
text while the answer is generated.

- Design and decisions: [DESIGN.md](DESIGN.md)
- Integration spec (endpoints, shapes, statuses, errors): [docs/API.md](docs/API.md)
- Agent rules used to build it: [CLAUDE.md](CLAUDE.md)
- Recording: **pending** (link to be added before submission; tracked in
  [DESIGN.md § Complete vs remaining](DESIGN.md#complete-vs-remaining))
- Status: complete and tested end to end with a fake model, but **built without an Anthropic API key**: no real
  Claude call has been made. See [Verification status](#verification-status) and
  [DESIGN.md § Complete vs remaining](DESIGN.md#complete-vs-remaining).
- Time: about 2 h 10 of wall-clock implementation time across 14 plan tasks (16:10–18:20 by commit times; the task
  agents themselves reported ~4 h 45), plus brainstorm/planning before that and code review after (total session
  time was not recorded). Breakdown in
  [DESIGN.md § Implementation plan and time log](DESIGN.md#implementation-plan-and-time-log).

## Requirements

Docker (with Compose), Node 22, pnpm 12 (12.21.0 wrote the lockfile and is pinned in the `Dockerfile`; older pnpm
may mishandle the `allowBuilds` list in `pnpm-workspace.yaml`) for local development and tests. `jq` for the
example flow.

## Run with Docker Compose

```sh
docker compose up --build
```

With no `.env` file this runs keyless with the fake model. To use Claude, create a repo-root `.env` first (copy
`.env.example` if your checkout has it, or this block) and fill in the key:

```sh
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-5-5
DATABASE_URL=postgres://curie:curie@localhost:54329/curie
REDIS_URL=redis://localhost:63799
PORT=3000
MAX_ANSWER_TOKENS=1024
MODEL_TIMEOUT_MS=90000
FULL_CONTEXT_TOKENS=60000
PASSAGE_TOKENS=400
MAX_DOCUMENT_BYTES=5242880
LOG_LEVEL=info
```

This starts Postgres 16, Redis 7, a one-shot `migrate`, the API on http://localhost:3000 and the worker. Host ports:
API 3000 (`API_PORT` overrides), Postgres 54329, Redis 63799.

Stop everything with `docker compose down` (add `-v` to drop the database volume).

## Model configuration

| Variable | Default | Notes |
|---|---|---|
| `MODEL_PROVIDER` | `anthropic` in the app; **`fake` under compose** | `anthropic` = Claude via the Messages API with Citations; `fake` = scripted demo model, no network |
| `ANTHROPIC_API_KEY` | — | Required when `MODEL_PROVIDER=anthropic` (the app refuses to start without it) |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | The request shape (Citations, adaptive thinking, `output_config.effort`) is assumed for the default model. Another model must accept all three; unverified (keyless build) |
| `MAX_ANSWER_TOKENS` | `1024` | Answer budget; the request adds 4096 tokens of thinking headroom |
| `MODEL_TIMEOUT_MS` | `90000` | Deadline for one streamed answer; a timeout is retried |
| `FULL_CONTEXT_TOKENS` | `60000` | Documents up to this estimated size are sent whole |
| `PASSAGE_TOKENS` | `400` | Target passage size |
| `MAX_DOCUMENT_BYTES` | `5242880` | Upload limit (UTF-8 bytes of `content`) |

Infrastructure and tooling:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://curie:curie@localhost:54329/curie` | Postgres; compose sets the in-network URL itself |
| `REDIS_URL` | `redis://localhost:63799` | Redis (BullMQ); compose sets the in-network URL itself |
| `PORT` | `3000` | API listen port (inside compose always 3000) |
| `API_PORT` | `3000` | Compose only: host port mapped to the API |
| `LOG_LEVEL` | `info` | pino level for the API and the worker (`debug` for more) |
| `TEST_DATABASE_URL` / `TEST_REDIS_URL` | `…/curie_test` on 54329 / `redis://localhost:63799` | Integration tests only |
| `EVAL_BASE_URL` / `EVAL_VERBOSE` | `http://localhost:3000` / unset | `pnpm eval` only |

The block above (and `.env.example`) lists the variables without credentials and sets `MODEL_PROVIDER=anthropic`,
so either fill in `ANTHROPIC_API_KEY` or change the provider to `fake`. A `.env` file is only needed for the
anthropic provider. Compose resolves `MODEL_PROVIDER` as shell >
`.env` > `fake` (`docker-compose.yml`), so with no `.env` at all the stack runs keyless with the fake model, and the
worker logs a warning saying so. Inside compose, `DATABASE_URL`/`REDIS_URL` are always
the in-network addresses; the `.env` values are for local runs.

The fake model answers every unscripted question with the document's first sentence, cited. It exercises the whole
pipeline (queue, partial writes, citation verification, offsets) but says nothing about answer quality.

## Example flow

Against a running stack, from the repo root (bash or zsh). These commands were run against
`docker compose up --build` with `MODEL_PROVIDER=fake`; the output below is from that run.

```sh
API=http://localhost:3000

# 1. Add a document (202, status pending)
DOC=$(jq -n --rawfile c samples/harbor-archive.md \
        '{title: "Harbor Archive", format: "markdown", content: $c}' |
      curl -s -H 'content-type: application/json' --data-binary @- $API/documents | jq -r .id)

# 2. Poll until ready (or failed, with failureCode/failureMessage)
until curl -s $API/documents/$DOC | jq -e '.status == "ready" or .status == "failed"' >/dev/null; do sleep 1; done
curl -s $API/documents/$DOC | jq '{status, passageCount, failureCode}'

# 3. Ask the first question (202 with ids)
ASK=$(jq -n --arg d "$DOC" '{documentId: $d, question: "How many questions did the hybrid prototype get right?"}' |
      curl -s -H 'content-type: application/json' --data-binary @- $API/conversations)
CONV=$(echo "$ASK" | jq -r .conversationId)
ANS=$(echo "$ASK" | jq -r .assistantMessageId)

# 4. Poll the answer until terminal; `content` grows while status is `streaming`
until curl -s $API/messages/$ANS | jq -e '.status == "completed" or .status == "failed"' >/dev/null; do sleep 1; done
curl -s $API/messages/$ANS | jq '{status, answerable, content, citations, error}'

# 5. Follow-up in the same conversation
ANS2=$(jq -n '{question: "And keyword search?"}' |
       curl -s -H 'content-type: application/json' --data-binary @- $API/conversations/$CONV/messages |
       jq -r .assistantMessageId)
until curl -s $API/messages/$ANS2 | jq -e '.status == "completed" or .status == "failed"' >/dev/null; do sleep 1; done
curl -s $API/conversations/$CONV | jq '[.messages[] | {seq, role, status}]'

# 6. Locate a quote: offsets index GET /documents/:id/content
curl -s $API/messages/$ANS | jq --argjson d "$(curl -s $API/documents/$DOC/content)" \
  '.citations[] | {quote, startOffset, endOffset, matches: ($d.content[.startOffset:.endOffset] == .quote)}'
```

Output (fake model; ids shortened):

```json
{"status": "ready", "passageCount": 5, "failureCode": null}

{"status": "completed", "answerable": true,
 "content": "Demo answer (fake model). The document says: This is a fictional research note created solely for a technical assessment.",
 "citations": [{"quote": "This is a fictional research note created solely for a technical assessment.",
   "startOffset": 34, "endOffset": 110, "heading": "Harbor Archive retrieval pilot",
   "passageId": "3df759d5-…", "answerStart": 45, "answerEnd": 121}],
 "error": null}

[{"seq": 1, "role": "user", "status": "completed"}, {"seq": 2, "role": "assistant", "status": "completed"},
 {"seq": 3, "role": "user", "status": "completed"}, {"seq": 4, "role": "assistant", "status": "completed"}]

{"quote": "This is a fictional research note created solely for a technical assessment.",
 "startOffset": 34, "endOffset": 110, "matches": true}
```

jq slices by code point, not UTF-16 unit; that is the same for this ASCII sample. See
[docs/API.md § Conventions](docs/API.md#conventions).

**Not found.** A question the document does not answer (e.g. "Who funded the study?") completes with
`"answerable": false`, `"citations": []` and `"content": "I could not find an answer to this question in the
document."` (for a document too large to send whole, the message says only the searched parts were checked). With the fake model this outcome is only reachable through scripted tests
(`test/integration/conversations.test.ts`); it has not been seen with real Claude (see below).

More responses (errors, 404s, a failed document) are in [docs/notes/manual-checks.md](docs/notes/manual-checks.md)
and [docs/API.md](docs/API.md).

## Local development

```sh
pnpm install
docker compose up -d postgres redis
pnpm migrate
pnpm dev:api        # http://localhost:3000
pnpm dev:worker
```

Outside compose `MODEL_PROVIDER` defaults to `anthropic`; without a key, set `MODEL_PROVIDER=fake` in `.env` or the
shell.

Local scripts and entrypoints load the repo-root `.env` if present; variables already set in the shell win. Tests
never read it.

## Tests

```sh
pnpm test:unit     # unit tests only, no services needed
pnpm test          # unit + integration; needs `docker compose up -d postgres redis`
pnpm typecheck
```

Integration tests use the `curie_test` database (created on first Postgres volume init) and fail fast with a hint if
Postgres or Redis is down. All tests use the fake model. Current result: 252 tests in 18 files pass (152 unit,
100 integration). What each level covers is in [DESIGN.md § Verification](DESIGN.md#verification).

`pnpm spike` (`scripts/spike-citations.ts`) dumps raw Citations responses for the sample document and needs an
Anthropic key.

## Eval

```sh
docker compose up --build -d   # with MODEL_PROVIDER=anthropic and ANTHROPIC_API_KEY in .env
pnpm eval                      # EVAL_BASE_URL (default http://localhost:3000); EVAL_VERBOSE=1 prints each answer
```

`scripts/eval.ts` drives the running API over HTTP: it uploads `samples/harbor-archive.md`, waits for `ready`, asks
the questions in [`samples/eval-questions.json`](samples/eval-questions.json) (a follow-up chain "How many questions
did the hybrid prototype get right?" → "And keyword search?" in one conversation; the pilot owner, next review date
and hybrid latency; two unanswerable questions, funding and production-scale latency), and checks each answer: the
expected `answerable` value, an expected substring in at least one citation quote, and every citation's offsets
slicing the stored content to its quote. It prints a table and exits 1 if any answer fails (2 if the harness itself
fails: API down, document failed, timeout). The assertions (`scripts/eval-check.ts`) are unit-tested, and the
harness runs in `pnpm test` against a listening app with the fake model (`test/integration/eval-harness.test.ts`).

**Results: not yet run (keyless).** No API key was available for this build, so the eval has never run against real
Claude. It was run once against the compose stack with `MODEL_PROVIDER=fake` to check the harness only: it ran end
to end and reported 0/7, as expected, because the fake model cites the document's first sentence for every question
(exit code 1; an unreachable `EVAL_BASE_URL` gives exit code 2). The sample document is sent whole (`full` mode), so
the eval does not cover `ranked` retrieval.

## Verification status

This build had **no Anthropic API key** (a deliberate decision to continue keyless). So:

Verified:
- `pnpm typecheck` and `pnpm test`: 252/252 passing, all against `FakeModel`, with real Postgres, Redis and BullMQ
  workers in the integration tests.
- The example flow above, over HTTP against the compose stack with `MODEL_PROVIDER=fake`: upload → ready → ask →
  poll → follow-up → offsets slice the stored content; plus 400/404/409/415 responses and a failed document
  (`empty_after_parse`).

Not verified:
- **No real Claude call was ever made.** `AnthropicModel` typechecks against `@anthropic-ai/sdk` 1.10.0 and its
  request body and stream handling are unit-tested through the real SDK client with a stubbed `fetch`, but the API
  has not accepted or answered one of our requests.
- The Citations request/response shapes are assumed from the Claude API docs and the SDK types
  ([docs/notes/citations-spike.md](docs/notes/citations-spike.md) marks each fact UNVERIFIED). If an assumption is
  wrong, citation verification drops the quotes (the answer then becomes "not found"); it cannot show a quote that
  is not in the document.
- `pnpm spike` has not been run, and `pnpm eval` has not been run against real Claude (only against the fake model,
  to check the harness); answer quality, `NOT_IN_DOCUMENT:` adherence and real latency are unknown. Real API error bodies (over-long prompt, 529, refusal) were not observed.
- Ranked retrieval for documents larger than `FULL_CONTEXT_TOKENS` is tested against real Postgres full-text
  search on a synthetic document, with `FakeModel` only; it has not been tried with the real model or a real long
  paper (the sample document is small enough to be sent whole).
- `docker compose up` with `MODEL_PROVIDER=anthropic`, a `.env` overriding the `fake` default, load, and many
  concurrent workers/pollers.

To verify with a key: set `MODEL_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env`, run `pnpm spike` and compare
`docs/notes/spike-output/` with the facts in `docs/notes/citations-spike.md`, then run `pnpm eval` against
`docker compose up --build` and record its table under [Eval](#eval). This is the first item of the remaining work;
the rest (SSE, query rewrite, hybrid ranking, `retry-after`, PDF, auth) is listed in priority order in
[DESIGN.md § Complete vs remaining](DESIGN.md#complete-vs-remaining).
