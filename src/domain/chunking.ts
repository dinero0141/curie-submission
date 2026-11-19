/**
 * Document chunking: content → blocks → sentences → passages.
 *
 * Every offset is a UTF-16 code unit index (JS string index) into the original, unmodified content,
 * half-open `[start, end)`. Each sentence span starts and ends on a non-whitespace character, so
 * `content.slice(start, end)` is that sentence's exact text and is never empty.
 *
 * Markdown is handled by a small line scanner (not a full CommonMark parser): ATX and setext headings,
 * fenced code, block quotes, list items, tables and thematic breaks. Syntax characters that are not
 * content (heading lines, fences, list/quote markers, table pipes) are kept out of sentence boundaries by
 * segmenting a *masked* copy of the content in which those characters are replaced by spaces; the copy has
 * the same length, so its indices are the content's indices. Inline markup (`**bold**`, links) stays in
 * the sentence text — quotations are exact slices of the stored document.
 */

/** Half-open `[start, end)` range in UTF-16 code units of the document content. */
export type Span = { start: number; end: number };

export type Passage = {
  ordinal: number;
  start: number;
  end: number;
  /** Text of the nearest preceding heading, or null (plain text, or text before any heading). */
  heading: string | null;
  sentences: Span[];
  /** `content.slice(start, end)`. */
  text: string;
  tokenEstimate: number;
};

export type DocumentFormat = 'markdown' | 'text';

export type ChunkingErrorCode = 'empty_after_parse' | 'too_many_passages';

/** Permanent preparation failure: re-running on the same content gives the same result. */
export class ChunkingError extends Error {
  constructor(
    readonly code: ChunkingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChunkingError';
  }
}

export type ChunkOptions = {
  /** Target passage size in estimated tokens (default 400). */
  passageTokens?: number;
  /** Fail with `too_many_passages` above this count (default: unlimited). */
  maxPassages?: number;
};

/** Rough token estimate; English averages ~4 chars per token (underestimates CJK). */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string | number): number {
  const len = typeof text === 'number' ? text : text.length;
  return Math.ceil(len / CHARS_PER_TOKEN);
}

type Block = { start: number; end: number; section: number; heading: string | null };

type Line = { start: number; end: number };

function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  const re = /\r\n|\n|\r/g;
  let start = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    lines.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  if (start < content.length) lines.push({ start, end: content.length });
  return lines;
}

const isBlank = (s: string) => /^\s*$/.test(s);
const firstNonWs = (s: string) => s.search(/\S/);

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE_SEP = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*(?::?-+:?[ \t]*)?\|?[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const LIST = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(?:\[[ xX]\][ \t]+)?|$)/;

/** Scan markdown into content blocks plus a same-length masked copy of the content. */
function scanMarkdown(content: string): { blocks: Block[]; masked: string } {
  const lines = splitLines(content);
  const blocks: Block[] = [];
  const maskedParts: string[] = [];
  let maskedUpTo = 0;
  /** Replace `[start, end)` of the content with spaces in the masked copy. */
  const mask = (start: number, end: number) => {
    if (end <= start) return;
    maskedParts.push(content.slice(maskedUpTo, start), ' '.repeat(end - start));
    maskedUpTo = end;
  };

  let section = 0;
  let heading: string | null = null;
  let para: { start: number; end: number; kind: 'plain' | 'item'; quoted: boolean } | null = null;
  let fence: { char: string; len: number } | null = null;

  const flush = () => {
    if (para) blocks.push({ start: para.start, end: para.end, section, heading });
    para = null;
  };
  const setHeading = (text: string) => {
    flush();
    section++;
    heading = text === '' ? null : text;
  };

  for (const [i, line] of lines.entries()) {
    let start = line.start;
    if (i === 0 && content.charCodeAt(0) === 0xfeff) {
      mask(0, 1);
      start = 1;
    }
    const raw = content.slice(start, line.end);

    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) fence = null;
      else if (!isBlank(raw)) blocks.push({ start: start + firstNonWs(raw), end: line.end, section, heading });
      continue;
    }
    const fenceOpen = FENCE_OPEN.exec(raw);
    if (fenceOpen) {
      flush();
      fence = { char: fenceOpen[1]![0]!, len: fenceOpen[1]!.length };
      continue;
    }
    if (isBlank(raw)) {
      flush();
      continue;
    }
    const atx = ATX.exec(raw);
    if (atx) {
      setHeading((atx[2] ?? '').trim());
      continue;
    }
    if (para && para.kind === 'plain' && !para.quoted && SETEXT.test(raw)) {
      const text = content.slice(para.start, para.end).replace(/\s+/g, ' ').trim();
      para = null;
      setHeading(text);
      continue;
    }
    if (THEMATIC.test(raw) || (raw.includes('|') && TABLE_SEP.test(raw))) {
      flush();
      continue;
    }

    // Strip (mask) block-quote markers, possibly nested.
    let offset = 0;
    let quoted = false;
    for (let q = QUOTE.exec(raw); q; q = QUOTE.exec(raw.slice(offset))) {
      offset += q[0].length;
      quoted = true;
    }
    mask(start, start + offset);
    const rest = raw.slice(offset);
    if (isBlank(rest)) {
      flush();
      continue;
    }
    if (para && para.quoted !== quoted) flush();

    if (/^ {0,3}\|/.test(rest)) {
      // Table row: one block per row, pipes masked.
      flush();
      for (let k = rest.indexOf('|'); k !== -1; k = rest.indexOf('|', k + 1)) mask(start + offset + k, start + offset + k + 1);
      if (!isBlank(rest.replace(/\|/g, ''))) {
        blocks.push({ start: start + offset + firstNonWs(rest.replace(/\|/g, ' ')), end: line.end, section, heading });
      }
      continue;
    }

    const item = LIST.exec(rest);
    if (item) {
      flush();
      mask(start + offset, start + offset + item[0].length);
      const body = rest.slice(item[0].length);
      if (!isBlank(body)) {
        para = { start: start + offset + item[0].length + firstNonWs(body), end: line.end, kind: 'item', quoted };
      }
      continue;
    }

    if (para) para.end = line.end;
    else para = { start: start + offset + firstNonWs(rest), end: line.end, kind: 'plain', quoted };
  }
  flush();
  maskedParts.push(content.slice(maskedUpTo));
  return { blocks, masked: maskedParts.join('') };
}

/** Plain text: blank-line separated paragraphs, nothing masked. */
function scanText(content: string): Block[] {
  const blocks: Block[] = [];
  let para: Line | null = null;
  for (const line of splitLines(content)) {
    const raw = content.slice(line.start, line.end);
    if (isBlank(raw)) {
      if (para) blocks.push({ ...para, section: 0, heading: null });
      para = null;
    } else if (para) para.end = line.end;
    else para = { start: line.start + firstNonWs(raw), end: line.end };
  }
  if (para) blocks.push({ ...para, section: 0, heading: null });
  return blocks;
}

/** Trim `[start, end)` of `text` to its first/last non-whitespace char; null when empty. */
function trimSpan(text: string, start: number, end: number): Span | null {
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return end > start ? { start, end } : null;
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Split an over-long span into pieces of at most `maxChars`, at whitespace when possible. */
function hardSplit(text: string, span: Span, maxChars: number): Span[] {
  const pieces: Span[] = [];
  let pos = span.start;
  while (span.end - pos > maxChars) {
    let cut = pos + maxChars;
    while (cut > pos && !/\s/.test(text[cut]!)) cut--;
    if (cut === pos) {
      cut = pos + maxChars;
      if (isLowSurrogate(text.charCodeAt(cut))) cut--; // never split a surrogate pair
    }
    const piece = trimSpan(text, pos, cut);
    if (piece) pieces.push(piece);
    pos = cut;
    while (pos < span.end && /\s/.test(text[pos]!)) pos++;
  }
  const last = trimSpan(text, pos, span.end);
  if (last) pieces.push(last);
  return pieces;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

function blockSentences(masked: string, block: Block, maxChars: number): Span[] {
  // Line breaks inside a block are soft wraps, not sentence ends (UAX #29 breaks after every LF).
  const text = masked.slice(block.start, block.end).replace(/[\r\n]/g, ' ');
  const out: Span[] = [];
  for (const seg of segmenter.segment(text)) {
    const span = trimSpan(masked, block.start + seg.index, block.start + seg.index + seg.segment.length);
    if (!span) continue;
    if (span.end - span.start > maxChars) out.push(...hardSplit(masked, span, maxChars));
    else out.push(span);
  }
  return out;
}

/**
 * Chunk a document into heading-bounded passages of whole sentences.
 * @throws ChunkingError `empty_after_parse` when no sentence survives; `too_many_passages` above `maxPassages`.
 */
export function chunkDocument(content: string, format: DocumentFormat, opts: ChunkOptions = {}): Passage[] {
  const passageTokens = opts.passageTokens ?? 400;
  const maxChars = passageTokens * CHARS_PER_TOKEN;
  const { blocks, masked } = format === 'markdown' ? scanMarkdown(content) : { blocks: scanText(content), masked: content };

  const passages: Passage[] = [];
  let cur: { section: number; heading: string | null; sentences: Span[] } | null = null;
  const push = () => {
    if (!cur) return;
    if (opts.maxPassages !== undefined && passages.length >= opts.maxPassages) {
      throw new ChunkingError('too_many_passages', `document produces more than ${opts.maxPassages} passages`);
    }
    const start = cur.sentences[0]!.start;
    const end = cur.sentences.at(-1)!.end;
    const text = content.slice(start, end);
    passages.push({
      ordinal: passages.length,
      start,
      end,
      heading: cur.heading,
      sentences: cur.sentences,
      text,
      tokenEstimate: estimateTokens(text),
    });
    cur = null;
  };

  for (const block of blocks) {
    for (const s of blockSentences(masked, block, maxChars)) {
      const fits =
        cur !== null && cur.section === block.section && estimateTokens(s.end - cur.sentences[0]!.start) <= passageTokens;
      if (fits) cur!.sentences.push(s);
      else {
        push();
        cur = { section: block.section, heading: block.heading, sentences: [s] };
      }
    }
  }
  push();

  if (passages.length === 0) {
    throw new ChunkingError('empty_after_parse', 'document has no text content after parsing');
  }
  return passages;
}
