# Curie API — integration spec

HTTP + JSON. Base URL `http://localhost:3000` under compose. No authentication (single user; see
[DESIGN.md § Access control](../DESIGN.md#access-control)). Source of truth: `src/http/routes/*`, `src/http/errors.ts`.

## Flow

1. `POST /documents` → `202 {id, status: "pending"}`.
2. Poll `GET /documents/:id` until `status` is `ready` (or `failed`, with `failureCode`/`failureMessage`).
3. `POST /conversations {documentId, question}` → `202 {conversationId, userMessageId, assistantMessageId}`.
4. Poll `GET /messages/:assistantMessageId` until `status` is `completed` or `failed`. While `streaming`, `content`
   holds the partial answer.
5. Follow-up: `POST /conversations/:id/messages {question}` → `202`, poll the new `assistantMessageId`.
6. To show a quote in context, fetch `GET /documents/:id/content` once and slice it with each citation's
   `startOffset`/`endOffset`.

Requests with a body must be `content-type: application/json`; any other type (`text/plain`, `text/markdown`,
form data) is a `415 unsupported_media_type`. All ids are UUIDs.

## Conventions

- **Errors** always use one envelope: `{"error": {"code": "document_not_ready", "message": "…"}}`. Branch on `code`;
  `message` is for humans and may change.
- **Offsets** (`startOffset`, `endOffset`, `answerStart`, `answerEnd`) are **UTF-16 code units** (JavaScript string
  indices), half-open `[start, end)`. `startOffset`/`endOffset` index the `content` string of
  `GET /documents/:id/content`, which is the uploaded content byte-for-byte and never changes. `answerStart`/`answerEnd`
  index the answer message's `content`. In JS, `content.slice(startOffset, endOffset) === quote`. In languages that
  index by code point (Python `str`, jq) or by byte (Go, Rust), convert first; for ASCII text all three agree.
- Timestamps are ISO 8601 UTC strings. Unknown fields may be added; ignore them.
- A malformed id is a `404 not_found`, the same as an unknown id.

## Endpoints

| Method | Path | Success | Purpose |
|---|---|---|---|
| `POST` | `/documents` | 202 | Add a document; preparation runs in the background |
| `GET` | `/documents` | 200 | List documents (newest first, without content) |
| `GET` | `/documents/:id` | 200 | Document status |
| `GET` | `/documents/:id/content` | 200 | The exact stored content (offset target) |
| `POST` | `/conversations` | 202 | Start a conversation with its first question |
| `POST` | `/conversations/:id/messages` | 202 | Ask a follow-up question |
| `GET` | `/conversations/:id` | 200 | Conversation with all messages in order |
| `GET` | `/messages/:id` | 200 | One message; poll this for an answer |
| `GET` | `/health` | 200 | `{"ok": true}` |

### `POST /documents`

```json
{"title": "Harbor Archive", "format": "markdown", "content": "# Harbor Archive retrieval pilot\n\n…"}
```

- `title`: string, trimmed, 1–300 chars; no NUL characters or unpaired UTF-16 surrogates (`400 invalid_request`).
- `format`: `"markdown"` or `"text"`. Markdown headings bound passages and become citation `heading`s; `text` splits
  on blank lines. PDF is not supported.
- `content`: string, at most `MAX_DOCUMENT_BYTES` (default 5 MiB) as UTF-8; not empty or whitespace-only; no NUL
  characters; no unpaired UTF-16 surrogates.

`202`:

```json
{"id": "5a8f8073-…-c1f4830a8560", "status": "pending"}
```

Errors: `400 invalid_request | invalid_json | empty_document | invalid_content`, `413 document_too_large |
payload_too_large`, `415 unsupported_media_type`.

### `GET /documents/:id`

```json
{"id": "5d1fe1e3-…", "title": "Harbor Archive", "format": "markdown", "status": "ready", "utf16Length": 1762,
 "passageCount": 5, "failureCode": null, "failureMessage": null,
 "createdAt": "2026-11-19T15:49:56.758Z", "updatedAt": "2026-11-19T15:49:56.775Z", "readyAt": "2026-11-19T15:49:56.775Z"}
```

A document that failed preparation (here: Markdown with only a heading):

```json
{"id": "a5354ffa-…", "title": "x", "format": "markdown", "status": "failed", "utf16Length": 16, "passageCount": null,
 "failureCode": "empty_after_parse", "failureMessage": "document has no text content after parsing",
 "createdAt": "…", "updatedAt": "…", "readyAt": null}
```

`GET /documents` returns `{"documents": [<same shape>, …]}`. Errors: `404 not_found`.

### `GET /documents/:id/content`

```json
{"id": "5d1fe1e3-…", "format": "markdown", "utf16Length": 1762, "content": "# Harbor Archive retrieval pilot\n\nThis i…"}
```

Available in every status. Errors: `404 not_found`.

### `POST /conversations`

```json
{"documentId": "5d1fe1e3-…", "question": "How many questions did the hybrid prototype get right?"}
```

`question`: string, trimmed, 1–2000 chars, no NUL characters or unpaired UTF-16 surrogates (same rule for
follow-ups). A conversation always starts with a question;
there is no empty conversation.

`202`:

```json
{"conversationId": "04e7f47c-…", "userMessageId": "a6defa98-…", "assistantMessageId": "a1908345-…"}
```

Errors: `400 invalid_request | invalid_json`, `404 not_found` (document), `409 document_not_ready` (status is
`pending`, `processing` or `failed`; the message names a failure code, e.g.
`"document is failed (empty_after_parse); wait until its status is ready"`).

### `POST /conversations/:id/messages`

```json
{"question": "And keyword search?"}
```

`202` with the same shape as `POST /conversations`. Errors: `400 invalid_request | invalid_json`, `404 not_found`
(conversation), `409 answer_in_progress`: the previous answer is still `pending` or `streaming`. The rejected
question is **not** stored; resend it once the previous answer is terminal.

### `GET /conversations/:id`

```json
{"id": "04e7f47c-…", "documentId": "5d1fe1e3-…", "createdAt": "…", "updatedAt": "…",
 "messages": [<user message>, <assistant message>, …]}
```

Messages are ordered by `seq` (1, 2, 3, …; user and assistant alternate). Errors: `404 not_found`.

### `GET /messages/:id`

User message:

```json
{"id": "a6defa98-…", "conversationId": "04e7f47c-…", "seq": 1, "role": "user", "status": "completed",
 "content": "Who owned the limited pilot?", "createdAt": "…", "updatedAt": "…", "completedAt": "…"}
```

Assistant message, `completed` (captured from the compose stack with `MODEL_PROVIDER=fake`, whose demo answer always
cites the document's first sentence):

```json
{
  "id": "a1908345-…", "conversationId": "04e7f47c-…", "seq": 2, "role": "assistant", "status": "completed",
  "content": "Demo answer (fake model). The document says: This is a fictional research note created solely for a technical assessment.",
  "createdAt": "2026-11-19T15:50:15.385Z", "updatedAt": "2026-11-19T15:50:15.394Z", "completedAt": "2026-11-19T15:50:15.394Z",
  "answerable": true,
  "citations": [
    {"quote": "This is a fictional research note created solely for a technical assessment.",
     "startOffset": 34, "endOffset": 110, "heading": "Harbor Archive retrieval pilot",
     "passageId": "3df759d5-…", "answerStart": 45, "answerEnd": 121}
  ],
  "finishReason": "end_turn",
  "error": null,
  "model": "fake",
  "usage": {"input_tokens": 0, "output_tokens": 0},
  "attempts": 1,
  "retrieval": {"mode": "full", "passageIds": ["3df759d5-…", "…"], "passageOrdinals": [0, 1, 2, 3, 4], "hits": [],
                "tokenEstimate": 416, "documentTokens": 416,
                "debug": {"query": null, "notFoundReason": null, "dropped": []}}
}
```

The `passageIds`, `hits` and `debug.query` fields were added with ranked retrieval after this capture; they are
filled in here from the code (`src/jobs/generateAnswer.ts`), not re-captured over HTTP.

`retrieval` for a document over `FULL_CONTEXT_TOKENS` (`ranked`). Shape from `test/integration/retrieval.test.ts`
(not captured over HTTP; ids and numbers illustrative); a follow-up's `debug.query.text` also carries the previous question:

```json
{"mode": "ranked",
 "passageIds": ["9a1c…", "4be0…", "c27f…"], "passageOrdinals": [15, 16, 17],
 "hits": [{"passageId": "4be0…", "ordinal": 16, "rank": 1, "score": 0.1}],
 "tokenEstimate": 412, "documentTokens": 9035,
 "debug": {"query": {"text": "Which universities lent lenses?", "tsquery": "'univers' | 'lent' | 'lens'"},
           "notFoundReason": null, "dropped": []}}
```

Assistant message, `completed` but not answerable. Shape from `src/jobs/generateAnswer.ts` and
`test/integration/conversations.test.ts`; not captured over HTTP, because the fake model's default answer is always
answerable. When `retrieval.mode` is `ranked` or `fallback` the model saw only part of the document, and `content`
is instead "I could not find an answer to this question in the parts of the document that were searched.":

```json
{"status": "completed", "answerable": false,
 "content": "I could not find an answer to this question in the document.", "citations": [],
 "retrieval": {"mode": "full", "…": "…",
               "debug": {"notFoundReason": "not_in_document", "rawText": "NOT_IN_DOCUMENT: …", "dropped": []}}}
```

Assistant message, `failed`:

```json
{"status": "failed", "content": "", "answerable": null, "citations": [],
 "error": {"code": "model_unavailable", "message": "…"}, "attempts": 3}
```

Errors: `404 not_found`.

#### Assistant fields

| Field | Meaning |
|---|---|
| `status` | See lifecycle below. |
| `content` | `pending`: `""`. `streaming`: partial raw model text, grows over time. `completed`: final text. `failed`: `""`. |
| `answerable` | `null` until `completed`. `true`: grounded answer with ≥ 1 verified citation (even if the reply also starts with the `NOT_IN_DOCUMENT:` marker, e.g. a partial answer; `content` is then the model text as written). `false`: no citation was verified and the model said the document does not answer the question (`NOT_IN_DOCUMENT:` marker, Markdown formatting and case tolerated); `content` is a fixed not-found message and `citations` is `[]`. A reply with no verified citation and no such statement is never `false`: it fails with `citations_unverified` (or `answer_truncated`). With `retrieval.mode: "full"` the whole document was sent; with `ranked`/`fallback` only part of it was, and the message says so. |
| `citations[]` | Verified quotations, in answer order. `quote` is `content.slice(startOffset, endOffset)` of the **document** (never model-written text); `heading` is the nearest Markdown heading (or `null`); `passageId` is internal. `[answerStart, answerEnd)` is the span of the **answer** `content` that this quote supports, for linking a claim to its source. A quote that spans several sentences is one contiguous slice, so it includes any Markdown syntax between them (list or quote markers, table pipes) that was masked out of what the model saw. |
| `finishReason` | Model stop reason, e.g. `end_turn`; `max_tokens` means the answer was cut at the length limit after at least one verified citation (a cut answer with none fails with `answer_truncated`). |
| `error` | `{code, message}` when `failed`, else `null`. |
| `attempts` | Processing runs started: normally ≤ 3 (one per BullMQ attempt), but a worker crash (stalled-job rerun) or a reconciler re-enqueue adds runs. |
| `model`, `usage` | Model id and the provider's token usage, as reported. |
| `retrieval` | What was sent to the model. `mode`: `full` (the whole document fits `FULL_CONTEXT_TOKENS`, no search), `ranked` (larger document: full-text search hits plus their neighbour passages), `fallback` (larger document but nothing to search for or no hits, e.g. a stopword-only question: the leading passages). `passageIds` / `passageOrdinals`: the passages sent, in document order (ordinal = position in the document, from 0). `hits`: search results best first, `{passageId, ordinal, rank (1-based), score}`; `[]` unless `ranked`; a hit missing from `passageIds` was cut by the token budget. `tokenEstimate` (sent) and `documentTokens` (whole document) use the `chars / 4` estimate. `debug` (including `debug.query`, the searched text and tsquery, `null` in `full` mode) is for diagnosis, not a stable contract. `null` until `completed`. |

## Status lifecycles

Document:

```
pending ──> processing ──> ready
   │            │
   └────────────┴────────> failed   (failureCode set)
```

`ready` and `failed` are terminal. A transient preparation error is retried (3 attempts) while the row stays
`processing`.

Assistant message (user messages are created `completed`):

```
pending ──> streaming ──> completed   (answerable true | false)
   ^            │
   └────────────┤  retryable error, before the last attempt: content reset to ""
                v
              failed                  (error.code set)
```

`completed` and `failed` are terminal. A `pending` message can also go straight to `failed` (reconciler,
`stalled`). After a terminal answer, the conversation accepts the next question; a failed turn is left out of the
history sent to the model.

## Polling

- Documents: poll `GET /documents/:id` every 1 s. The sample document is ready within a second; preparation takes
  about 160 ms of CPU for a 5 MB file, plus queue latency.
- Answers: poll `GET /messages/:id` every 500 ms–1 s until `completed` or `failed`. The worker writes partial `content`
  at most every 400 ms, so polling faster gains nothing.
- Treat `streaming` text as provisional: it is unverified model text, citations appear only with `completed`, and an
  answer that turns out not answerable replaces it with the not-found message. If a retry happens, `status` goes back
  to `pending` and `content` to `""`; render whatever the latest poll returns.
- A streaming answer bumps `updatedAt` with every partial write. The worker's reconciler checks in-flight rows
  untouched for 2 minutes: a lost job is enqueued again, a job that died is marked `failed` (`stalled`). Clients need
  no timeout logic of their own beyond a generous upper bound (several minutes).

## Error codes

HTTP errors (`{"error": {code, message}}`):

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request` | Body fails validation (missing/empty/too long field, NUL or unpaired surrogate in `title`/`question`, unknown `format`, body not an object), bad `content-length` |
| 400 | `invalid_json` | Body is empty or not valid JSON |
| 400 | `empty_document` | `content` is empty or whitespace-only |
| 400 | `invalid_content` | `content` contains NUL or an unpaired UTF-16 surrogate |
| 404 | `not_found` | Unknown or malformed id, unknown route |
| 409 | `document_not_ready` | Asking about a document that is not `ready` |
| 409 | `answer_in_progress` | Asking while the conversation's previous answer is in flight |
| 413 | `document_too_large` | `content` exceeds `MAX_DOCUMENT_BYTES` (UTF-8 bytes) |
| 413 | `payload_too_large` | Whole body exceeds 1.5 × `MAX_DOCUMENT_BYTES` |
| 415 | `unsupported_media_type` | Body is not `application/json` (e.g. `text/plain`, `text/markdown`, form data) |
| 500 | `internal_error` | Unexpected server error |

Document `failureCode`:

| Code | Meaning | Retry? |
|---|---|---|
| `empty_after_parse` | No text left after removing Markdown syntax (headings, fences only) | Fix the content and upload again |
| `too_many_passages` | More than 20,000 passages (pathological input) | Upload a smaller or less fragmented document |
| `preparation_error` | Unexpected error on all 3 attempts; `failureMessage` is generic (details are only in the worker log) | Upload again |
| `stalled` | The background job was lost or failed outside the processor; `failureMessage` is generic (the job's error is only in the worker log) | Upload again |

Answer `error.code`:

| Code | Meaning | Retry? |
|---|---|---|
| `model_unavailable` | Rate limit, overload, 5xx, network error or timeout on all 3 attempts | Ask again later |
| `context_too_large` | The model rejected the prompt as too long | Not retried; asking again sends the same passages |
| `model_config_error` | Request rejected (bad key, unknown model, invalid request) | No; operator problem |
| `model_refused` | The model declined to answer | Rephrase |
| `answer_truncated` | The answer hit the `max_tokens` limit before it cited the document; says nothing about whether the document answers the question. Not retried | Ask a narrower question; operators can raise `MAX_ANSWER_TOKENS` |
| `citations_unverified` | The model answered, but no citation could be verified against the document (it cited nothing, or every citation failed verification); says nothing about whether the document answers the question. Not retried; the worker log has each drop reason | Ask again or rephrase; if it happens for every question, operators should check the Citations shapes (`docs/notes/citations-spike.md`) |
| `internal_error` | Server bug or inconsistent data; `message` is generic (details are only in the worker log) | Ask again |
| `stalled` | Job lost or failed outside the processor | Ask again |

The error `message` of a failed answer may contain provider error text (never internal details: `internal_error`
and `stalled` always carry a generic message, as do `preparation_error` and `stalled` on documents); show
`code`-based copy to end users.
