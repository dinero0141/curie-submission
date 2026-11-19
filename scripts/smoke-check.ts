/**
 * Pure part of the live smoke run (`scripts/smoke.ts`): the questions, the per-answer check and the printed report.
 * No I/O here, so it is unit-tested (`test/unit/smoke-check.test.ts`). The check is the eval's (`checkAnswer` in
 * `scripts/eval-check.ts`) applied to what the processor would store for a `resolveCitations` result.
 */
import type { ResolvedAnswer } from '../src/domain/citations.js';
import type { PromptMessage } from '../src/llm/prompt.js';
import { checkAnswer, type AnswerView, type CheckResult, type Outcome } from './eval-check.js';

export type SmokeQuestion = {
  id: string;
  question: string;
  expect: Outcome;
  /**
   * A follow-up: the id of the earlier question whose question and answer are sent as history (not simply the
   * question that ran last; `smokeHistory`).
   */
  followUpOf?: string;
};

/** Few questions on purpose: each is one model request, and free-tier quotas are small. */
export const SMOKE_QUESTIONS: SmokeQuestion[] = [
  { id: 'keyword', question: 'How many of the 40 questions did keyword search answer?', expect: { answerable: true, quoteIncludes: '28 of the 40' } },
  { id: 'budget', question: "What was the pilot's budget?", expect: { answerable: false } },
  {
    id: 'hybrid-followup',
    question: 'And the hybrid prototype?',
    expect: { answerable: true, quoteIncludes: '34 of the 40' },
    followUpOf: 'keyword',
  },
];

/**
 * History answer for the keyword follow-up when the keyword answer did not complete: the document's own sentence,
 * so the follow-up still tests history handling rather than failing because of the first question.
 */
export const FALLBACK_KEYWORD_ANSWER = 'Keyword search returned a relevant passage for 28 of the 40 questions.';

/** A finished smoke turn: its answer text when it was answerable, else `null`. */
export type SmokeTurn = { question: string; answer: string | null };

/**
 * History for `q`: none unless it is a follow-up; else the turn named by `followUpOf` (its question, and its
 * answer or `FALLBACK_KEYWORD_ANSWER` when that answer did not complete). Throws when that turn has not run, which
 * is a mistake in `SMOKE_QUESTIONS`.
 */
export function smokeHistory(q: SmokeQuestion, turns: ReadonlyMap<string, SmokeTurn>): PromptMessage[] {
  if (!q.followUpOf) return [];
  const turn = turns.get(q.followUpOf);
  if (!turn) throw new Error(`smoke question ${q.id} follows up on ${q.followUpOf}, which has not run before it`);
  return [
    { role: 'user', content: turn.question, status: 'completed' },
    { role: 'assistant', content: turn.answer ?? FALLBACK_KEYWORD_ANSWER, status: 'completed' },
  ];
}

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
