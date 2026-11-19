/**
 * Pure part of the live smoke run (`scripts/smoke.ts`): the questions, the per-answer check and the printed report.
 * No I/O here, so it is unit-tested (`test/unit/smoke-check.test.ts`). The check is the eval's (`checkAnswer` in
 * `scripts/eval-check.ts`) applied to what the processor would store for a `resolveCitations` result.
 */
import type { ResolvedAnswer } from '../src/domain/citations.js';
import { checkAnswer, type AnswerView, type CheckResult, type Outcome } from './eval-check.js';

export type SmokeQuestion = {
  id: string;
  question: string;
  expect: Outcome;
  /** Send the previous question and its answer as history (a follow-up). */
  followUp?: boolean;
};

/** Few questions on purpose: each is one model request, and free-tier quotas are small. */
export const SMOKE_QUESTIONS: SmokeQuestion[] = [
  { id: 'keyword', question: 'How many of the 40 questions did keyword search answer?', expect: { answerable: true, quoteIncludes: '28 of the 40' } },
  { id: 'budget', question: "What was the pilot's budget?", expect: { answerable: false } },
  { id: 'hybrid-followup', question: 'And the hybrid prototype?', expect: { answerable: true, quoteIncludes: '34 of the 40' }, followUp: true },
];

/**
 * History for a follow-up when the first answer did not complete: the document's own sentence, so the follow-up
 * still tests history handling rather than failing because of the first question.
 */
export const FALLBACK_KEYWORD_ANSWER = 'Keyword search returned a relevant passage for 28 of the 40 questions.';

/**
 * What the processor would store for this result (`status`, `answerable`, `content`, `citations`, `error`):
 * `truncated` and `unverified` are failed answers (`answer_truncated`, `citations_unverified`).
 */
export function toAnswerView(resolved: Pick<ResolvedAnswer, 'answerable' | 'text' | 'citations' | 'notFoundReason'>): AnswerView {
  if (resolved.notFoundReason === 'truncated') {
    return { status: 'failed', answerable: null, content: '', citations: [], error: { code: 'answer_truncated', message: 'max_tokens before any verified citation' } };
  }
  if (resolved.notFoundReason === 'unverified') {
    return { status: 'failed', answerable: null, content: '', citations: [], error: { code: 'citations_unverified', message: 'no citation survived verification' } };
  }
  return { status: 'completed', answerable: resolved.answerable, content: resolved.text, citations: resolved.citations, error: null };
}

export function checkSmokeAnswer(
  resolved: Pick<ResolvedAnswer, 'answerable' | 'text' | 'citations' | 'notFoundReason'>,
  expect: Outcome,
  content: string,
): CheckResult {
  return checkAnswer(toAnswerView(resolved), [expect], content);
}

export type SmokeRow = {
  id: string;
  question: string;
  resolved: Pick<ResolvedAnswer, 'answerable' | 'text' | 'citations' | 'dropped' | 'notFoundReason' | 'rawText'>;
  stopReason: string;
  model: string;
  usage: unknown;
  seconds: number;
  check: CheckResult;
};

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Drop reasons with counts, e.g. `cited_text_mismatch×2, block_out_of_range×1`, or `none`. */
export function dropSummary(dropped: { reason: string }[]): string {
  if (dropped.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${reason}×${n}`).join(', ');
}

/** The per-question block printed by the smoke run. Contains no configuration (and so never the API key). */
export function formatSmokeRow(r: SmokeRow): string {
  const lines = [
    `${r.check.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.question}`,
    `  outcome: ${r.resolved.notFoundReason ?? 'answerable'}; verified citations: ${r.resolved.citations.length}; dropped: ${dropSummary(r.resolved.dropped)}`,
    `  stopReason: ${r.stopReason}; model: ${r.model}; ${r.seconds.toFixed(1)} s; usage: ${JSON.stringify(r.usage)}`,
    `  answer: ${cut((r.resolved.answerable ? r.resolved.text : r.resolved.rawText).replace(/\s+/g, ' '), 300)}`,
    ...r.resolved.citations.map((c) => `  quote [${c.startOffset}, ${c.endOffset}): ${JSON.stringify(c.quote)}`),
    `  check: ${r.check.reason}`,
  ];
  return lines.join('\n');
}
