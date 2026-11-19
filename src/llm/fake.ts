/**
 * Scripted, offline `AnswerModel` for tests and `MODEL_PROVIDER=fake` demo mode.
 *
 * - scripts match the question by case-insensitive substring (first match wins, newest script first);
 * - every request is recorded in `requests`;
 * - a script can fail its first attempts with given errors (`errors[n]` is thrown on attempt n + 1), before
 *   streaming or, with `midStreamErrors`, after half of the text has streamed (and after the latch);
 * - a script can be latched: it streams the first half of its text, then waits until `release()`;
 * - unknown questions get a default answer citing the first sentence of the first passage.
 *
 * Citations it emits use the `content_block_location` shape from `docs/notes/citations-spike.md` (assumed,
 * not observed live), so they go through the same `resolveCitations` checks as real ones.
 */
import { ModelRefusalError } from './errors.js';
import type { AnswerModel, AnswerRequest, RawAnswer, RawCitation } from './types.js';

export type FakeBlock = { text: string; citations?: RawCitation[] | null };

export type FakeReply =
  | { text: string; stopReason?: string }
  | { blocks: FakeBlock[]; stopReason?: string }
  | ((req: AnswerRequest) => { blocks: FakeBlock[]; stopReason?: string });

export type FakeScript = {
  /** Case-insensitive substring of the question. */
  match: string;
  /** Defaults to the demo answer (first sentence of the first passage, cited). */
  reply?: FakeReply;
  /** Thrown on consecutive attempts for this script, in order; later attempts reply normally. */
  errors?: unknown[];
  /** Hold the answer half-streamed until `release()` is called. */
  latch?: boolean;
  /** Throw `errors` after the first half of the text has streamed (after the latch, if set), not before. */
  midStreamErrors?: boolean;
};

type ScriptState = FakeScript & { attempts: number; gate: Gate | null };

class Gate {
  open = false;
  private waiters: (() => void)[] = [];
  wait(signal: AbortSignal): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }
  release(): void {
    this.open = true;
    for (const w of this.waiters.splice(0)) w();
  }
}

/** A `content_block_location` citation of blocks `[start, end)` of `req.documents[documentIndex]`. */
export function fakeCitation(req: AnswerRequest, documentIndex: number, start: number, end = start + 1): RawCitation {
  const doc = req.documents[documentIndex];
  if (!doc) throw new Error(`fakeCitation: no document ${documentIndex}`);
  return {
    type: 'content_block_location',
    cited_text: doc.blocks.slice(start, end).join(''),
    document_index: documentIndex,
    document_title: doc.title,
    start_block_index: start,
    end_block_index: end,
    file_id: null,
  };
}

/** Demo answer: the first sentence of the first passage, cited. */
export function defaultReply(req: AnswerRequest): { blocks: FakeBlock[] } {
  const first = req.documents[0]?.blocks[0] ?? '';
  return {
    blocks: [
      { text: 'Demo answer (fake model). The document says: ' },
      { text: first, citations: req.documents.length > 0 ? [fakeCitation(req, 0, 0)] : [] },
    ],
  };
}

const MODEL_NAME = 'fake';

export class FakeModel implements AnswerModel {
  /** Every request received, in call order. */
  readonly requests: AnswerRequest[] = [];
  private readonly scripts: ScriptState[] = [];
  private latchedListeners: ((req: AnswerRequest) => void)[] = [];

  constructor(scripts: FakeScript[] = []) {
    for (const s of scripts) this.script(s);
  }

  /** Add a script; newer scripts take precedence over older ones with an overlapping `match`. */
  script(s: FakeScript): this {
    this.scripts.unshift({ ...s, attempts: 0, gate: s.latch ? new Gate() : null });
    return this;
  }

  /** Release latched scripts (those whose `match` equals `match`, or all). Later calls pass straight through. */
  release(match?: string): void {
    for (const s of this.scripts) if (s.gate && (match === undefined || s.match === match)) s.gate.release();
  }

  /** Resolves with the request once a call is waiting at a latch. */
  whenLatched(): Promise<AnswerRequest> {
    return new Promise((resolve) => this.latchedListeners.push(resolve));
  }

  get lastRequest(): AnswerRequest | undefined {
    return this.requests.at(-1);
  }

  async generate(req: AnswerRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<RawAnswer> {
    this.requests.push(req);
    signal.throwIfAborted();
    const q = req.question.toLowerCase();
    const s = this.scripts.find((x) => q.includes(x.match.toLowerCase()));

    const attempt = s ? s.attempts++ : 0;
    const failing = s?.errors !== undefined && attempt < s.errors.length;
    if (failing && !s.midStreamErrors) throw s.errors![attempt];

    const reply = resolveReply(s?.reply, req);
    const text = reply.blocks.map((b) => b.text).join('');
    const half = Math.floor(text.length / 2);

    if (s?.gate) {
      if (half > 0) onDelta(text.slice(0, half));
      const wasOpen = s.gate.open;
      const waiting = s.gate.wait(signal);
      if (!wasOpen) for (const l of this.latchedListeners.splice(0)) l(req);
      await waiting;
      if (failing) throw s.errors![attempt];
      if (text.length > half) onDelta(text.slice(half));
    } else if (failing) {
      if (half > 0) onDelta(text.slice(0, half));
      throw s!.errors![attempt];
    } else {
      for (const b of reply.blocks) if (b.text) onDelta(b.text);
    }

    const stopReason = reply.stopReason ?? 'end_turn';
    if (stopReason === 'refusal') throw new ModelRefusalError(null);
    return {
      blocks: reply.blocks.map((b) => ({ text: b.text, citations: b.citations ?? null })),
      stopReason,
      usage: { input_tokens: 0, output_tokens: 0 },
      model: MODEL_NAME,
    };
  }
}

function resolveReply(reply: FakeReply | undefined, req: AnswerRequest): { blocks: FakeBlock[]; stopReason?: string } {
  if (reply === undefined) return defaultReply(req);
  if (typeof reply === 'function') return reply(req);
  if ('text' in reply) return { blocks: [{ text: reply.text }], ...(reply.stopReason ? { stopReason: reply.stopReason } : {}) };
  return reply;
}
