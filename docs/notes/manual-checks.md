# Manual checks

Checks run by hand against the running stack, with the real responses (trimmed: long ids and fields cut where marked `…`).
Automated coverage lives in `test/`; this file records what was seen outside the test runner.

## 2026-11-19 — compose stack, `MODEL_PROVIDER=fake` (Task 8, keyless run)

Setup: `docker compose up -d --build --wait` with no dotenv file present, so `MODEL_PROVIDER` resolved to `fake`
(`docker compose config` showed `MODEL_PROVIDER: fake` for api/worker/migrate; with `MODEL_PROVIDER=anthropic` in
the shell it showed `anthropic`). `migrate` exited 0 (`migrations applied: 001_init.sql`), api healthy, worker logged
`queues: [prepare-document, generate-answer], modelProvider: fake` plus a warning that answers come from the demo model.

The fake model's default answer cites the first sentence of the first passage, so in this mode answers do not depend on
the question; the point of the check is the HTTP flow, job pipeline and offset slicing, not answer quality.

1. Upload `samples/harbor-archive.md` → `202`

   ```json
   {"id":"5a8f8073-…-c1f4830a8560","status":"pending"}
   ```

2. Poll `GET /documents/:id` → `ready`

   ```json
   {"id":"5a8f8073-…","title":"Harbor Archive","format":"markdown","status":"ready","utf16Length":1762,
    "passageCount":5,"failureCode":null,"failureMessage":null,"readyAt":"2026-11-19T15:39:03.303Z", …}
   ```

3. `POST /conversations` `{documentId, question: "How many questions did the hybrid prototype get right?"}` → `202`

   ```json
   {"conversationId":"2ef75527-…","userMessageId":"cd487170-…","assistantMessageId":"ab74ec11-…"}
   ```

4. Poll `GET /messages/:assistantMessageId` → `completed` (the fake answers in ~10 ms, so the first poll already saw it)

   ```json
   {"seq":2,"role":"assistant","status":"completed",
    "content":"Demo answer (fake model). The document says: This is a fictional research note created solely for a technical assessment.",
    "answerable":true,
    "citations":[{"quote":"This is a fictional research note created solely for a technical assessment.",
      "startOffset":34,"endOffset":110,"heading":"Harbor Archive retrieval pilot","passageId":"e4262b0d-…",
      "answerStart":45,"answerEnd":121}],
    "finishReason":"end_turn","error":null,"model":"fake","attempts":1,
    "retrieval":{"mode":"full","passageOrdinals":[0,1,2,3,4],"tokenEstimate":416,"documentTokens":416,
      "debug":{"notFoundReason":null}}, …}
   ```

5. Follow-up `POST /conversations/:id/messages` `{question: "And keyword search?"}` → `202`, polled → `completed`,
   `attempts: 1`, same demo citation. `GET /conversations/:id` lists the turns in order:

   ```json
   {"messages":[{"seq":1,"role":"user","status":"completed","content":"How many questions did the hybrid prototype get right?"},
     {"seq":2,"role":"assistant","status":"completed", …},
     {"seq":3,"role":"user","status":"completed","content":"And keyword search?"},
     {"seq":4,"role":"assistant","status":"completed", …}]}
   ```

6. Offsets checked against `GET /documents/:id/content` (`utf16Length: 1762`, content length 1762). For both answers
   `content.slice(34, 110) === quote` (sliced with jq; the sample is ASCII, so code points equal UTF-16 units here) and
   `answer.content.slice(answerStart, answerEnd)` is the cited sentence:

   ```json
   {"startOffset":34,"endOffset":110,"quote":"This is a fictional research note created solely for a technical assessment.",
    "sliceMatches":true,"answerSpan":"This is a fictional research note created solely for a technical assessment."}
   ```

7. Errors: unknown `documentId` → `404 {"error":{"code":"not_found","message":"document not found"}}`; whitespace
   question → `400 {"error":{"code":"invalid_request","message":"question must not be empty"}}`.

8. Shutdown: `docker compose stop api worker` → both logged `shutting down` on SIGTERM and exited cleanly.

Not seen in this run:
- `409 answer_in_progress` and partial `content` while `streaming`: the fake answers before a second request can arrive,
  so two quick questions both got `202`. Both behaviours are covered by `test/integration/conversations.test.ts` with a
  latched FakeModel.
- Precedence of a dotenv value for `MODEL_PROVIDER` over the `fake` default was not exercised: no dotenv file exists in
  this checkout and the session's rules forbid creating one. It follows from compose reading that file for `${...}`
  interpolation; shell > file > `fake`.
- Real-provider compose run (`MODEL_PROVIDER=anthropic`): **not run — no API key (keyless run)**.

## 2026-11-19 — README example flow re-run, `MODEL_PROVIDER=fake` (Task 10, keyless run)

Setup: `docker compose up -d --build --wait` on the Task 9 code (image rebuilt), no dotenv file, so the fake model.
The six steps of the README "Example flow" were run verbatim from the repo root; their output is the one shown in the
README (document `ready` with 5 passages, answer `completed` with one citation at `[34, 110)`, four messages in seq
order, `matches: true` for the offset check).

Extra responses seen in the same run:

```text
POST /documents {"format":"pdf",…}              → {"error":{"code":"invalid_request","message":"format must be 'markdown' or 'text'"}}
POST /documents (content-type: text/markdown)   → {"error":{"code":"unsupported_media_type","message":"send the request body as application/json"}}
GET /documents/not-a-uuid                       → {"error":{"code":"not_found","message":"document not found"}}
POST /documents {"content":"# only a heading"}  → 202 pending, then GET → "status":"failed","failureCode":"empty_after_parse",
                                                  "failureMessage":"document has no text content after parsing"
POST /conversations about that document         → {"error":{"code":"document_not_ready","message":"document is failed (empty_after_parse); wait until its status is ready"}}
POST /conversations/<unknown uuid>/messages     → {"error":{"code":"not_found","message":"conversation not found"}}
```

App containers removed afterwards (`docker compose rm -sf api worker migrate`), images and build cache pruned.
Still not seen over HTTP: a not-found answer (the fake's default answer always cites), partial content while
`streaming` and `409 answer_in_progress` (the fake answers too fast); all three are covered by integration tests.

## 2026-11-19 — fresh-clone check of the README, `MODEL_PROVIDER=fake` (Task 13, keyless run)

Setup: `git clone` of the worktree's committed state (`e913283`) into a scratch directory, with the worktree's own
compose stack stopped first to free the ports. The clone has no dotenv file and no `.env.example` (that file was
still uncommitted at this point; the user commits it), so the README's optional `cp` step was skipped. Then, in the
clone:

- `docker compose up -d --build --wait` → image built, `migrate` exited 0, `api` and `worker` healthy;
  `docker compose config` showed `MODEL_PROVIDER: fake` for every app service (the default when nothing overrides it).
- The README "Example flow" block, copied out of the clone's README and run unchanged with `bash -e` → exit 0.
  Output matched the README: document `ready` with 5 passages; answer `completed`, `answerable: true`, one citation at
  `[34, 110)` with `answerStart 45` / `answerEnd 121`; four messages in seq order (user, assistant, user, assistant);
  the offset check printed `matches: true`.
- Extra, same stack: the sample uploaded as `format: "text"` → `ready` with 2 passages (plain text keeps the Markdown
  syntax as content, so the first sentence is the `# Harbor Archive retrieval pilot` line); a question about it →
  `completed`, `retrieval.mode: "full"`, citation `[0, 32)` slicing to its quote. `{"content": "# only a heading"}` →
  `failed`, `empty_after_parse`, "document has no text content after parsing".
- By mistake the first extraction picked the README's "Local development" block instead, so `pnpm install`,
  `pnpm migrate` and `pnpm dev:api` also ran in the clone: install and migrate succeeded, and `dev:api` refused to
  start with `ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic (set MODEL_PROVIDER=fake for offline mode)`.
  That is the documented behaviour (outside compose the provider defaults to `anthropic`, and the README says to set
  `MODEL_PROVIDER=fake` without a key), not a README defect.

Teardown: `docker compose down -v --rmi local` in the clone, clone directory removed, `docker image prune -f`, the
worktree's postgres/redis started again.

Not covered by this check: the `anthropic` provider (no API key, keyless run) and the README's
`cp .env.example .env` step (file not committed yet).
