/**
 * Pure part of the live eval (`scripts/eval.ts`): the question-file schema, the per-answer assertion and the
 * result table. No I/O here, so it is unit-tested (`test/unit/eval-check.test.ts`).
 */
import { z } from 'zod';

/**
 * One acceptable outcome. `answerable: true` needs at least one citation whose quote contains `quoteIncludes`
 * (case-insensitive, whitespace collapsed). `answerable: false` needs the not-found shape: no citations.
 */
const OutcomeSchema = z.discriminatedUnion('answerable', [
  z.object({ answerable: z.literal(true), quoteIncludes: z.string().trim().min(1) }).strict(),
  z.object({ answerable: z.literal(false) }).strict(),
]);

const TurnSchema = z
  .object({
    id: z.string().trim().min(1),
    question: z.string().trim().min(1).max(2000),
    /** Any one of these outcomes passes. Usually one; a second when two answers are both defensible. */
    expect: z.array(OutcomeSchema).min(1),
    note: z.string().optional(),
  })
  .strict();

export const EvalSuiteSchema = z
  .object({
    document: z.object({ path: z.string().min(1), title: z.string().min(1), format: z.enum(['markdown', 'text']) }).strict(),
    /** Each conversation is one chain of turns; turns after the first are follow-ups in the same conversation. */
    conversations: z.array(z.array(TurnSchema).min(1)).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const seen = new Set<string>();
    for (const turn of suite.conversations.flat()) {
      if (seen.has(turn.id)) ctx.addIssue({ code: 'custom', message: `duplicate turn id "${turn.id}"` });
      seen.add(turn.id);
    }
  });

export type Outcome = z.infer<typeof OutcomeSchema>;
export type EvalTurn = z.infer<typeof TurnSchema>;
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

/** Parse and validate the question file; throws an Error listing every problem. */
export function parseEvalSuite(json: unknown): EvalSuite {
  const parsed = EvalSuiteSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new Error(`invalid eval file:\n  ${issues.join('\n  ')}`);
}

/** The fields of `GET /messages/:id` (assistant) that the eval reads. */
export type AnswerView = {
  status: string;
  answerable: boolean | null;
  content: string;
  citations: { quote: string; startOffset: number; endOffset: number }[];
  error: { code: string; message: string } | null;
};

export type CheckResult = { pass: boolean; reason: string };

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Assert one terminal answer against its acceptable outcomes. `documentContent` is `GET /documents/:id/content`;
 * every citation must slice it exactly (offsets are UTF-16 code units, the same as JS string indices), whatever
 * the expectation, because a citation that does not locate its quote is a bug regardless of the question.
 */
export function checkAnswer(answer: AnswerView, expect: Outcome[], documentContent: string): CheckResult {
  if (answer.status !== 'completed') {
    const err = answer.error ? `${answer.error.code}: ${answer.error.message}` : 'no error recorded';
    return { pass: false, reason: `status ${answer.status} (${err})` };
  }
  const misplaced = answer.citations.find((c) => documentContent.slice(c.startOffset, c.endOffset) !== c.quote);
  if (misplaced) {
    return { pass: false, reason: `citation [${misplaced.startOffset},${misplaced.endOffset}) does not slice to its quote` };
  }

  const failures: string[] = [];
  for (const outcome of expect) {
    if (outcome.answerable === false) {
      if (answer.answerable !== false) failures.push(`expected not found, got answerable=${answer.answerable}`);
      else if (answer.citations.length > 0) failures.push(`not found but ${answer.citations.length} citation(s)`);
      else return { pass: true, reason: 'not found, as expected' };
      continue;
    }
    if (answer.answerable !== true) {
      failures.push(`expected an answer quoting "${outcome.quoteIncludes}", got not found`);
      continue;
    }
    const want = norm(outcome.quoteIncludes);
    if (answer.citations.some((c) => norm(c.quote).includes(want))) {
      return { pass: true, reason: `quote contains "${outcome.quoteIncludes}"` };
    }
    failures.push(`no citation quote contains "${outcome.quoteIncludes}" (${answer.citations.length} citation(s))`);
  }
  return { pass: false, reason: failures.join('; or ') };
}

export type EvalRow = { id: string; question: string; pass: boolean; reason: string; seconds: number | null };

/** Plain-text table for the terminal, plus a summary line. Long questions/reasons are cut to keep rows on one line. */
export function formatTable(rows: EvalRow[]): string {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const cells = rows.map((r) => [
    r.pass ? 'PASS' : 'FAIL',
    r.id,
    cut(r.question, 60),
    r.seconds === null ? '-' : r.seconds.toFixed(1),
    cut(r.reason, 90),
  ]);
  const header = ['result', 'id', 'question', 'secs', 'detail'];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd();
  const passed = rows.filter((r) => r.pass).length;
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line), '', `${passed}/${rows.length} passed`].join('\n');
}
