/**
 * Citation mapping and verification: model Citations output → verified quotations with source offsets.
 *
 * Built against the Citations shapes in `docs/notes/citations-spike.md`. Those shapes are ASSUMED (from the
 * claude-api skill and the `@anthropic-ai/sdk` 1.10.0 types) and were NOT observed live. The code is written
 * so that a wrong assumption can only drop a citation, never produce a wrong quote (and an answer left with no
 * verified citation is `unverified`, which fails the answer, never shown as "not in the document"):
 * - only `content_block_location` citations are accepted; indices must be integers inside what we sent;
 * - `cited_text` must equal the cited blocks joined, compared with all whitespace removed (the separator is
 *   undocumented). This is the check that tests the model's output: if the index semantics were different
 *   from what we assume (say `end_block_index` inclusive, or 1-based), `cited_text` would cover other blocks
 *   and the citation is dropped. It is never used as the quote. Remaining gap: an off-by-one index that lands
 *   on an identical repeated sentence passes, with the right quote text but the other sentence's offsets;
 * - the quote is always `content.slice(startOffset, endOffset)` built from our stored sentence spans (the
 *   blocks we sent are those same slices, built by `toSentDocument`). A quote spanning several sentences is
 *   one contiguous slice, so it includes any Markdown syntax between them (list or quote markers, a table
 *   pipe row) that was masked out of the sentence blocks.
 *
 * Pure, no I/O.
 */
import type { Span } from './chunking.js';

/** Prefix the model is told to start with when the document does not answer the question. */
export const NOT_IN_DOCUMENT_MARKER = 'NOT_IN_DOCUMENT:';

/**
 * Marker at the start of the reply: after whitespace and Markdown emphasis/code/quote/heading characters
 * (`**NOT_IN_DOCUMENT:**`, `` `NOT_IN_DOCUMENT:` ``, `> NOT_IN_DOCUMENT -`), any case, followed by anything but a
 * letter or digit. Marker adherence of the real model is unknown (spike fact 16), so formatting is tolerated.
 */
const MARKER_AT_START = /^[\s*_`>#]*NOT_IN_DOCUMENT(?![A-Za-z0-9])/i;
/** Marker anywhere (e.g. after a one-sentence preamble); only consulted when the model cited nothing at all. */
const MARKER_ANYWHERE = /(?<![A-Za-z0-9])NOT_IN_DOCUMENT(?![A-Za-z0-9])/i;

/**
 * Whether the reply says the document does not answer the question. When the model emitted any citation, verified
 * or dropped, only a marker at the start counts: a cited answer may mention the word, and a partial answer ("X
 * [cited]. NOT_IN_DOCUMENT: Y is not stated.") whose citations were all dropped by verification is evidence of a
 * shape mismatch, not of a missing answer (it stays `unverified`). With no citation at all, the marker anywhere counts.
 */
export function hasNotInDocumentMarker(text: string, modelCited: boolean): boolean {
  return MARKER_AT_START.test(text) || (!modelCited && MARKER_ANYWHERE.test(text));
}

/** Displayed text when an answer is not grounded in the document. */
export const NOT_FOUND_MESSAGE = 'I could not find an answer to this question in the document.';

/**
 * Displayed instead of `NOT_FOUND_MESSAGE` when the model saw only part of a large document (`ranked` or
 * `fallback` retrieval), so "not found" cannot mean "the document does not say".
 */
export const NOT_FOUND_IN_SEARCHED_MESSAGE =
  'I could not find an answer to this question in the parts of the document that were searched.';

/**
 * One citation as received from the model. Deliberately `unknown`: the shape is assumed, not verified, so
 * every field is checked at runtime. The Anthropic adapter passes the SDK's citation objects as they are.
 */
export type RawCitation = unknown;

/** Model output as read from `stream.finalMessage()`: text blocks only, in order (thinking blocks removed). */
export type RawAnswer = {
  blocks: { text: string; citations: readonly RawCitation[] | null }[];
  stopReason: string;
  usage: unknown;
  model: string;
};

/**
 * One custom-content document as sent to the model: one passage, one text block per sentence.
 * `blocks[i]` is the exact text sent for `sentences[i]`; `documents[i]` in the request is `sent[i]` here.
 */
export type SentDocument = {
  passageId: string;
  heading: string | null;
  sentences: Span[];
  blocks: string[];
};

export type Citation = {
  /** `content.slice(startOffset, endOffset)` — never model-written text. */
  quote: string;
  startOffset: number;
  endOffset: number;
  heading: string | null;
  passageId: string;
  /** `[answerStart, answerEnd)` of the answer text that this quote supports. */
  answerStart: number;
  answerEnd: number;
};

export type DropReason =
  | 'malformed'
  | 'unsupported_type'
  | 'document_out_of_range'
  | 'block_out_of_range'
  | 'cited_text_missing'
  | 'cited_text_mismatch';

export type DroppedCitation = {
  reason: DropReason;
  /** Index of the answer text block that carried the citation. */
  answerBlock: number;
  citation: RawCitation;
};

export type ResolvedAnswer = {
  answerable: boolean;
  /**
   * Text to display: the model text if answerable, `NOT_FOUND_MESSAGE` for `not_in_document`, else `''`
   * (`truncated` and `unverified` are failed by the processor, never displayed).
   */
  text: string;
  citations: Citation[];
  dropped: DroppedCitation[];
  /** The model's text blocks concatenated, kept for debugging. */
  rawText: string;
  /**
   * Why `answerable` is false. Only `not_in_document` (the model's explicit marker) means the document lacks
   * the answer. `truncated`: the reply hit `max_tokens` before any citation survived (the processor fails it
   * with `answer_truncated`). `unverified`: the model answered but no citation survived verification, either
   * because it cited nothing or because every citation was dropped (the likely sign of a Citations shape
   * mismatch); the processor fails it with `citations_unverified`, never as "not in the document".
   */
  notFoundReason: 'not_in_document' | 'unverified' | 'truncated' | null;
};

/** Build the document we send for a passage: the block texts are exact slices of the content. */
export function toSentDocument(
  passage: { id: string; heading: string | null; sentences: Span[] },
  content: string,
): SentDocument {
  return {
    passageId: passage.id,
    heading: passage.heading,
    sentences: passage.sentences,
    blocks: passage.sentences.map((s) => content.slice(s.start, s.end)),
  };
}

const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const stripWs = (s: string) => s.replace(/\s+/gu, '');

type Located = Omit<Citation, 'answerStart' | 'answerEnd'>;

function locate(c: RawCitation, sent: SentDocument[], content: string): Located | DropReason {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return 'malformed';
  const r = c as Record<string, unknown>;
  if (r.type !== 'content_block_location') return 'unsupported_type';

  const docIndex = r.document_index;
  if (!isIndex(docIndex) || docIndex < 0 || docIndex >= sent.length) return 'document_out_of_range';
  const doc = sent[docIndex]!;

  const start = r.start_block_index;
  const end = r.end_block_index; // exclusive (assumed; checked against cited_text below)
  // `blocks` and `sentences` have the same length (`toSentDocument`).
  if (!isIndex(start) || !isIndex(end) || start < 0 || end <= start || end > doc.sentences.length) {
    return 'block_out_of_range';
  }

  if (typeof r.cited_text !== 'string') return 'cited_text_missing';
  if (stripWs(r.cited_text) !== stripWs(doc.blocks.slice(start, end).join(''))) return 'cited_text_mismatch';

  const startOffset = doc.sentences[start]!.start;
  const endOffset = doc.sentences[end - 1]!.end;
  return { quote: content.slice(startOffset, endOffset), startOffset, endOffset, heading: doc.heading, passageId: doc.passageId };
}

/**
 * Map the model's citations to verified source quotations and decide whether the answer is grounded.
 * Not answerable when the reply carries the `NOT_IN_DOCUMENT` marker (see `hasNotInDocumentMarker`) or when no
 * citation survives verification. Only the marker is reported as "not in the document"; otherwise a
 * `max_tokens` stop is `truncated` and anything else is `unverified`.
 */
export function resolveCitations(raw: RawAnswer, sent: SentDocument[], content: string): ResolvedAnswer {
  const citations: Citation[] = [];
  const dropped: DroppedCitation[] = [];
  let rawText = '';

  raw.blocks.forEach((block, answerBlock) => {
    const answerStart = rawText.length;
    rawText += block.text;
    const answerEnd = rawText.length;
    for (const c of block.citations ?? []) {
      const located = locate(c, sent, content);
      if (typeof located === 'string') {
        dropped.push({ reason: located, answerBlock, citation: c });
        continue;
      }
      const prev = citations.at(-1);
      if (
        prev &&
        prev.passageId === located.passageId &&
        prev.startOffset === located.startOffset &&
        prev.endOffset === located.endOffset &&
        prev.answerEnd >= answerStart
      ) {
        prev.answerEnd = Math.max(prev.answerEnd, answerEnd);
        continue;
      }
      citations.push({ ...located, answerStart, answerEnd });
    }
  });

  const notFoundReason = hasNotInDocumentMarker(rawText, citations.length > 0 || dropped.length > 0)
    ? 'not_in_document'
    : citations.length === 0
      ? raw.stopReason === 'max_tokens'
        ? 'truncated'
        : 'unverified'
      : null;

  if (notFoundReason) {
    const text = notFoundReason === 'not_in_document' ? NOT_FOUND_MESSAGE : '';
    return { answerable: false, text, citations: [], dropped, rawText, notFoundReason };
  }
  return { answerable: true, text: rawText, citations, dropped, rawText, notFoundReason: null };
}
