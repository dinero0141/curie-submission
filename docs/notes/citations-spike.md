# Citations spike — assumed shapes (keyless run)

> **Status: UNVERIFIED — not observed live.** This run had no Anthropic API key, so `pnpm spike` was
> never executed. Every fact below comes from the `claude-api` skill (bundled with Claude Code
> 2.1.325, model table cached 2026-11-03) or from the installed `@anthropic-ai/sdk` **1.10.0** type
> definitions and stream helper source. They are what the docs and types *say*, not what the API was
> seen to return. `src/domain/citations.ts` (Task 5) is built against these assumed shapes and
> defends against them being wrong (out-of-range indices dropped, every quote re-verified against
> `content.slice`). See "How to verify later" at the end.

Paths below are relative to `node_modules/@anthropic-ai/sdk/`. Line numbers are for 1.10.0.

## Facts and sources

| # | Fact (assumed) | Source | Status |
|---|---|---|---|
| 1 | Current Sonnet model id is `claude-sonnet-5-5` (no date suffix). The skill's general default is `claude-opus-5-5`; this project's config defaults to Sonnet (the plan's choice), and `ANTHROPIC_MODEL` overrides it. | skill `SKILL.md` § Current Models; `resources/messages/messages.d.ts:3916` (`type Model` lists `'claude-sonnet-5-5'`) | UNVERIFIED — not observed live |
| 2 | Custom-content document = `{ type: 'document', source: { type: 'content', content: [{ type: 'text', text }, ...] }, title?, context?, citations?: { enabled: true } }`. `content` may also be a plain string, but then there are no blocks to point at, so we always send an array of text blocks. | `messages.d.ts:3563-3567` (`ContentBlockSource`, `ContentBlockSourceContent = TextBlockParam \| ImageBlockParam`), `messages.d.ts:3613-3623` (`DocumentBlockParam`: `source`, `title`, `context`, `citations`, `cache_control`) | UNVERIFIED — not observed live |
| 3 | Citations are switched on per document with `citations: { enabled: true }`, and the setting must be the same on all documents in a request ("all or none"). | skill § Document & File Input → Citations; `messages.d.ts:2374` (`CitationsConfigParam { enabled?: boolean }`) | UNVERIFIED — not observed live |
| 4 | For custom content, the response gives citations of type `content_block_location` with `cited_text`, `document_index`, `document_title`, `start_block_index`, `end_block_index`, `file_id`. | `messages.d.ts:2259-2285` (`CitationContentBlockLocation`); `messages.d.ts:4151-4162` (`TextBlock.citations` doc: "content document results in `content_block_location`") | UNVERIFIED — not observed live |
| 5 | `start_block_index` is 0-based. `end_block_index` is **exclusive** and "always greater than `start_block_index`". A single-block citation has `end = start + 1`. So the cited sentences are `sentences[start .. end-1]` and the source span is `[spans[start].start, spans[end-1].end)`. | `messages.d.ts:2269-2281` (doc comments on `end_block_index` / `start_block_index`) | UNVERIFIED — not observed live |
| 6 | `cited_text` "always equals the contents of `content[start_block_index:end_block_index]` joined together". The block is the smallest unit that can be cited, so `cited_text` is never a part of one block. The comment does **not** name a separator. We do not rely on one: `cited_text` is compared with the cited blocks joined, with all whitespace removed. That comparison is the check on the model's output: it is what catches a wrong index-semantics assumption (inclusive or 1-based `end_block_index`). It is never used as the quote. (The blocks we send are `content.slice(span)` by construction, so comparing them with our own spans tests nothing; that self-check was removed.) Remaining gap: an off-by-one index landing on an identical repeated sentence passes, with the right quote text but the other sentence's offsets. | `messages.d.ts:2260-2267` (doc comment on `cited_text`) | UNVERIFIED — not observed live; separator unknown |
| 7 | `document_index` semantics are **not documented** in the types (no doc comment). Assumption: the 0-based position of the document among the `document` blocks in the request, in order. To make this safe whichever way the API counts, documents are sent **only in the final user message** (history is plain text), so "index across the request" and "index within the message" give the same number. | `messages.d.ts:2268` (field, no comment); design choice | UNVERIFIED — not observed live |
| 8 | The response is split into several `text` blocks. Cited blocks carry a `citations` array, uncited blocks carry `null`. | skill § Citations ("Response splits into multiple `text` blocks; cited blocks carry a `citations` array"); `messages.d.ts:4151-4162` (`citations: Array<TextCitation> \| null`) | UNVERIFIED — not observed live |
| 9 | Streaming: citations arrive as `content_block_delta` events with `delta.type === 'citations_delta'` and `delta.citation`. The SDK's `MessageStream` appends each one to the snapshot's text block, so `stream.finalMessage()` returns text blocks with their full `citations` arrays. Text arrives as `text_delta` (use `stream.on('text')` for partial content). | `messages.d.ts:2377-2380` (`CitationsDelta`); `lib/MessageStream.js:421-426` (emits `citation`), `lib/MessageStream.js:537-545` (accumulates into `snapshot.content[i].citations`) | UNVERIFIED — not observed live (the SDK code was read, the event stream was not seen) |
| 10 | SDK 1.10.0 sends `anthropic-version: 2026-10-21`. On that version, `temperature`/`top_p`/`top_k` are a 400 on every model (and 1.10.0's `MessageCreateParams` has no such fields). | `client.js:979`; skill `shared/api-version-migration.md` § 2026-10-21 change 1 | UNVERIFIED — not observed live |
| 11 | On `2026-10-21`, a `text` block with non-empty `citations` in a **user** message is a 400, and a `document` block directly in an **assistant** message is a 400. Citations on assistant text blocks are still accepted. We send history as plain text in both roles anyway, which avoids both. | skill `shared/api-version-migration.md` changes 2 and 3 | UNVERIFIED — not observed live |
| 12 | Citations cannot be combined with structured outputs (`output_config.format` → 400). This is why "not found" is a text marker (`NOT_IN_DOCUMENT:`), not a JSON field. | skill § Citations ("Incompatible with `output_config.format`") | UNVERIFIED — not observed live |
| 13 | Sonnet 5.5 thinking: omitting `thinking` runs adaptive thinking. `{type:'disabled'}` is a 400. `{type:'between_tools'}` turns thinking off, takes no other field, and works only at effort `high` or below (the default effort is `high`). Thinking tokens count toward `max_tokens`, and with the default `display: 'omitted'` a response can start with a `thinking` block with empty text, so read blocks by `type`, never by position. | skill § Thinking & Effort table; `shared/model-migration.md` § Migrating to Claude Sonnet 5.5 → Breaking change 1; `messages.d.ts:4278-4292` (`ThinkingConfigAdaptive`, `ThinkingConfigBetweenTools`, `ThinkingConfigDisabled`) | UNVERIFIED — not observed live |
| 14 | Sonnet 5.5 may decline with `stop_reason: 'refusal'` (HTTP 200, `stop_details.category`). The skill recommends the server-side `fallbacks: "default"` beta (`server-side-fallback-2026-07-01`, `client.beta.messages`). Decided in Task 6: not enabled yet (plain `model_refused`); see DESIGN.md § Model integration. | skill § Claude Fable 5.2 → `refusal` stop reason; `shared/model-migration.md` § Sonnet 5.5 → Safeguards and fallback | UNVERIFIED — not observed live |
| 15 | Limits on the number of documents per request or blocks per document: **not stated** in the skill or the SDK types. Unknown until the spike runs. | none found | UNKNOWN |
| 16 | Whether the model actually follows the `NOT_IN_DOCUMENT:` instruction (for example, adds no text before it) is behaviour, not a shape. It cannot be known without live calls. `resolveCitations` therefore matches the marker tolerantly (Markdown emphasis/code/quote characters, any case, and anywhere in the reply when the model emitted no citation at all; with citations that were all dropped only a marker at the start counts; a reply with a verified citation is answerable whatever the marker says); a reply with no verified citation and no marker fails as `citations_unverified`, never as not-found. `pnpm spike` reports `markerExact` (instructed format) next to `notInDocument` (accepted). | none (behaviour) | UNKNOWN |

## Chosen packaging: one custom-content document per passage

Each passage we send becomes one `document`: `title` = the passage heading (or the document title for
text before the first heading), `content` = one text block per sentence span, `citations.enabled`.

Why (reasoning from the shapes above, not from observed behaviour):

- **Contiguity.** In `ranked` mode (Task 11) the passages we send are not adjacent in the source. If all
  sentences went into one document, a citation could run across a gap (the last sentence of passage 3
  plus the first sentence of passage 9). Mapping that to one `[start, end)` span would quote unsent
  text between them. With one document per passage, a block range always stays inside one passage, and
  a passage is a run of consecutive sentences. So `[spans[start].start, spans[end-1].end)` is a real,
  contiguous slice of the source.
- **Direct mapping.** `document_index` → passage. Block index → sentence index inside that passage.
  No global block table is needed.
- **Headings as titles** give the model section context and fill `citation.heading` for free.
- **Never empty.** Chunking guarantees every passage has at least one sentence, so no document has
  zero blocks (`buildRequest` asserts it anyway).

Cost, and what would change the choice: `full` mode can send many documents (about 150 at
`FULL_CONTEXT_TOKENS` = 60k with 400-token passages; the sample document gives 5 passages and 20
sentence blocks). If the live run shows a document-count limit (fact 15), or much worse citation
quality than the single-document run, the fallback is **one document per run of adjacent passages**.
That keeps the contiguity property and sends fewer documents. The spike script already runs both
packagings, so this can be compared.

## Implications for Task 5 (`resolveCitations`) and Task 6 (`buildRequest`)

- Accept only `type === 'content_block_location'`. Drop any other citation type and report it.
- Drop a citation if `document_index` is outside the sent documents, or if
  `!(0 <= start < end <= blocks.length)`.
- Verify by comparing `cited_text` with the cited blocks joined (whitespace removed, since the separator
  is unknown); together with the index range checks this is the guard against a wrong shape assumption.
  Never build the quote from `cited_text`: the quote is always `content.slice(offsets)`.
- `answerStart`/`answerEnd` come from the text-block lengths in `finalMessage().content`, in order,
  counting only `text` blocks (thinking blocks are skipped).
- `buildRequest`: documents only in the final user message, then the question as a text block. History
  turns are plain strings (no citations, no documents). No `temperature`. Leave `thinking` out
  (adaptive) or set `between_tools`. Size `max_tokens` for thinking plus the answer
  (`MAX_ANSWER_TOKENS` = 1024 may be tight with adaptive thinking; decide in Task 6).
- Task 6 decisions: `thinking` omitted (adaptive) with `output_config.effort: 'medium'`; `max_tokens` =
  `MAX_ANSWER_TOKENS` + 4096 thinking headroom; no `fallbacks` beta. The request body is pinned by
  `test/unit/prompt.test.ts`, and `test/unit/anthropic-model.test.ts` drives the real SDK client through a
  stubbed `fetch` with SSE events written from these assumed shapes. Neither is a live observation.

## How to verify later

1. Put `ANTHROPIC_API_KEY` in the repo-root dotenv file (or export it), with `MODEL_PROVIDER=anthropic`.
2. Run `pnpm spike` (5 small streaming requests against the sample document; small cost). Each request
   is built by the production code path, `toAnthropicParams(buildRequest(...))`: the production system
   prompt and user text, `max_tokens` = `MAX_ANSWER_TOKENS` + 4096 thinking headroom, and
   `output_config.effort: 'medium'`. The `single` packaging and the `between_tools` thinking setting are
   extra variants on top of that body; each run file records what was sent under `request`.
3. Look in `docs/notes/spike-output/`:
   - `summary.json`: one row per run. On every `*-answerable` run, first check `shapeOk: true`: `citations > 0`
     (`content_block_location` citations) and `citationTypes` holds no other type, and production verified at
     least one (`verified > 0`, `notFoundReason: null`). Zero citations, or citations of another type (for
     example `char_location`), is the shape mismatch these checks exist to catch: do not mark facts 3-6
     observed. Then check `allInRange: true` and `allConcat: true` (`null` means there was nothing to check,
     which is inconclusive, never a pass; `cited_text` == blocks joined with no separator; if `false`, look
     at `checks[].citedTextEqualsSpaceJoin` in the run file), `multiBlock` (are there citations over several
     blocks?), `notInDocument: true` for the `*-unanswerable` runs (computed with the production rule,
     `resolveCitations`), and `stop: "end_turn"` (a `max_tokens` stop means thinking used up the
     headroom: the run is inconclusive, not a shape mismatch). A run without an `error` row also confirms
     that the API accepts `output_config.effort` and the `max_tokens` production sends. Compare `firstTextMs`/`totalMs` for the
     `between-tools` run against `per-passage-answerable`.
   - `<run>.json`: `eventTypes` should include `content_block_delta:citations_delta`.
     `finalMessage.content` shows the text-block split, any leading `thinking` block, and the raw
     `content_block_location` objects. Check that `document_index` matches the per-passage
     `sent[].documentIndex`. `checks[].sliceStartsWithFirstBlock` should be `true`.
   - Any `error` row: a 400 there may mean a document/block limit (fact 15) or a request-shape mistake.
4. Then update this file: change each row's status to "observed <date>", or record the difference,
   and fix `src/domain/citations.ts` and its tests if a shape differs.
