/**
 * Citation mapping and verification: model Citations output → verified quotations with source offsets.
 *
 * Built against the Citations shapes in `docs/notes/citations-spike.md`. Those shapes are ASSUMED (from the
 * claude-api skill and the `@anthropic-ai/sdk` 1.10.0 types) and were NOT observed live. The code is written
 * so that a wrong assumption can only drop a citation, never produce a wrong quote:
 * - only `content_block_location` citations are accepted; indices must be integers inside what we sent;
 * - each cited block is compared with the text we sent for that block, which must be exactly
 *   `content.slice(span)`;
 * - `cited_text` must equal the cited blocks joined, compared with all whitespace removed (the separator is
 *   undocumented). It is never used as the quote. If the index semantics were different from what we assume
 *   (say `end_block_index` inclusive, or 1-based), `cited_text` would cover other blocks and the citation is
 *   dropped;
 * - the quote is always `content.slice(startOffset, endOffset)` built from our stored sentence spans.
 *
 * Pure, no I/O.
 */
import type { Span } from './chunking.js';

/** Prefix the model is told to start with when the document does not answer the question. */
export const NOT_IN_DOCUMENT_MARKER = 'NOT_IN_DOCUMENT:';

/** Displayed text when an answer is not grounded in the document. */
export const NOT_FOUND_MESSAGE = 'I could not find an answer to this question in the document.';

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
  | 'sent_text_mismatch'
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
  /** Text to display: the model text if answerable, else `NOT_FOUND_MESSAGE`. */
  text: string;
  citations: Citation[];
  dropped: DroppedCitation[];
  /** The model's text blocks concatenated, kept for debugging. */
  rawText: string;
  notFoundReason: 'not_in_document' | 'no_verified_citations' | null;
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
  if (!isIndex(start) || !isIndex(end) || start < 0 || end <= start || end > doc.blocks.length || end > doc.sentences.length) {
    return 'block_out_of_range';
  }

  for (let i = start; i < end; i++) {
    const span = doc.sentences[i]!;
    if (doc.blocks[i] !== content.slice(span.start, span.end)) return 'sent_text_mismatch';
  }

  if (typeof r.cited_text !== 'string') return 'cited_text_missing';
  if (stripWs(r.cited_text) !== stripWs(doc.blocks.slice(start, end).join(''))) return 'cited_text_mismatch';

  const startOffset = doc.sentences[start]!.start;
  const endOffset = doc.sentences[end - 1]!.end;
  return { quote: content.slice(startOffset, endOffset), startOffset, endOffset, heading: doc.heading, passageId: doc.passageId };
}

/**
 * Map the model's citations to verified source quotations and decide whether the answer is grounded.
 * Not answerable when the reply starts with `NOT_IN_DOCUMENT_MARKER` (after leading whitespace) or when no
 * citation survives verification.
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

  const notFoundReason = rawText.trimStart().startsWith(NOT_IN_DOCUMENT_MARKER)
    ? 'not_in_document'
    : citations.length === 0
      ? 'no_verified_citations'
      : null;

  if (notFoundReason) {
    return { answerable: false, text: NOT_FOUND_MESSAGE, citations: [], dropped, rawText, notFoundReason };
  }
  return { answerable: true, text: rawText, citations, dropped, rawText, notFoundReason: null };
}
