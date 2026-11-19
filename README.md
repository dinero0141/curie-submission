# Curie — chat with a document

Backend for asking questions about one Markdown or plain-text document. Documents are prepared in a background
worker; answers come only from the selected document, with quotations that are verified against the stored text and
located by character offsets, or an explicit "not in this document" result. Clients poll for answers and see partial
text while the answer is generated.

- Design and decisions: [DESIGN.md](DESIGN.md)
- Integration spec (endpoints, shapes, statuses, errors): [docs/API.md](docs/API.md)
- Agent rules used to build it: [CLAUDE.md](CLAUDE.md)
- Recording: TBD

## Requirements

Docker (with Compose), Node 22, pnpm (only for local development and tests). `jq` for the example flow.

## Run with Docker Compose

```sh
cp .env.example .env     # optional; then set ANTHROPIC_API_KEY, or MODEL_PROVIDER=fake
docker compose up --build
```

This starts Postgres 16, Redis 7, a one-shot `migrate`, the API on http://localhost:3000 and the worker. Host ports:
API 3000 (`API_PORT` overrides), Postgres 54329, Redis 63799.

Stop everything with `docker compose down` (add `-v` to drop the database volume).

## Model configuration

| Variable | Default | Notes |
|---|---|---|
| `MODEL_PROVIDER` | `anthropic` in the app; **`fake` under compose** | `anthropic` = Claude via the Messages API with Citations; `fake` = scripted demo model, no network |
| `ANTHROPIC_API_KEY` | — | Required when `MODEL_PROVIDER=anthropic` (the app refuses to start without it) |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Any Claude model that supports Citations |
| `MAX_ANSWER_TOKENS` | `1024` | Answer budget; the request adds 4096 tokens of thinking headroom |
| `MODEL_TIMEOUT_MS` | `90000` | Deadline for one streamed answer; a timeout is retried |
| `FULL_CONTEXT_TOKENS` | `60000` | Documents up to this estimated size are sent whole |
| `PASSAGE_TOKENS` | `400` | Target passage size |
| `MAX_DOCUMENT_BYTES` | `5242880` | Upload limit (UTF-8 bytes of `content`) |

`.env.example` lists every variable without credentials and sets `MODEL_PROVIDER=anthropic`, so after copying it
either fill in `ANTHROPIC_API_KEY` or change the provider to `fake`. Compose resolves `MODEL_PROVIDER` as shell >
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
document."`. With the fake model this outcome is only reachable through scripted tests
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
Postgres or Redis is down. All tests use the fake model. Current result: 180 tests in 13 files pass (114 unit,
66 integration). What each level covers is in [DESIGN.md § Verification](DESIGN.md#verification).

`pnpm spike` (`scripts/spike-citations.ts`) dumps raw Citations responses for the sample document and needs an
Anthropic key. `pnpm eval` is planned (Task 12); `scripts/eval.ts` does not exist yet.

## Verification status

This build had **no Anthropic API key** (a deliberate decision to continue keyless). So:

Verified:
- `pnpm typecheck` and `pnpm test`: 180/180 passing, all against `FakeModel`, with real Postgres, Redis and BullMQ
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
- `pnpm spike` and `pnpm eval` have not been run; answer quality, `NOT_IN_DOCUMENT:` adherence and real latency are
  unknown. Real API error bodies (over-long prompt, 529, refusal) were not observed.
- Documents larger than `FULL_CONTEXT_TOKENS` currently get only their leading passages (`fallback`); ranked
  retrieval is in progress (plan Task 11).
- `docker compose up` with `MODEL_PROVIDER=anthropic`, a `.env` overriding the `fake` default, load, and many
  concurrent workers/pollers.

To verify with a key: set `MODEL_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env`, run `pnpm spike` and compare
`docs/notes/spike-output/` with the facts in `docs/notes/citations-spike.md`, then rerun the example flow and ask
"Who funded the study?" to see a not-found answer.
