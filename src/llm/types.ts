/**
 * Provider-neutral model interface. `buildRequest` (prompt.ts) produces an `AnswerRequest`; an `AnswerModel`
 * (Anthropic, Gemini or Fake) turns it into a `RawAnswer`, which `resolveCitations` maps to verified quotations.
 */
import type { RawAnswer, SentDocument } from '../domain/citations.js';

export type { RawAnswer, RawCitation, SentDocument } from '../domain/citations.js';

/** One passage as sent: `SentDocument` (blocks = exact content slices) plus the title the model sees. */
export type RequestDocument = SentDocument & { title: string };

/** One earlier completed question/answer pair, as plain text. */
export type HistoryTurn = { question: string; answer: string };

export type AnswerRequest = {
  system: string;
  /** `documents[i]` is sent as request document `i`; `resolveCitations` takes this same array. */
  documents: RequestDocument[];
  /** Oldest first. */
  history: HistoryTurn[];
  question: string;
  /** Final user text after the documents (the question, with the document title). */
  userText: string;
};

export interface AnswerModel {
  /**
   * Generate one answer. `onDelta` receives answer text as it streams (text blocks only). Rejects with an
   * error that `classifyError` understands; a refusal rejects with `ModelRefusalError`.
   */
  generate(req: AnswerRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<RawAnswer>;
}
