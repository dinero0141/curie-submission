/**
 * HTTP side of the live eval: drives a running API with an eval suite and returns one row per question.
 * Used by the CLI (`scripts/eval.ts`) and by `test/integration/eval-harness.test.ts`, which runs it against a
 * listening app with real workers and `FakeModel`. Assertions live in `scripts/eval-check.ts`.
 */
import { type AnswerView, type EvalRow, type EvalSuite, checkAnswer } from './eval-check.js';

export class HarnessError extends Error {}

export type RunOptions = {
  baseUrl: string;
  suite: EvalSuite;
  /** The document text to upload (the file at `suite.document.path`). */
  content: string;
  pollMs?: number;
  documentTimeoutMs?: number;
  /**
   * Keep above the server's worst case so a slow answer fails server-side with an error code (a FAIL row)
   * instead of a harness timeout: 3 attempts × MODEL_TIMEOUT_MS (90 s) + 1 s + 2 s backoff ≈ 273 s.
   */
  answerTimeoutMs?: number;
  /** Called with every terminal answer (for verbose output). */
  onAnswer?: (turnId: string, answer: AssistantMessage) => void;
};

export type AssistantMessage = AnswerView & {
  model: string | null;
  attempts: number;
  retrieval: { mode?: string } | null;
};

export type RunResult = { documentId: string; rows: EvalRow[]; models: string[] };

type Accepted = { conversationId: string; assistantMessageId: string };
type DocumentStatus = { status: string; failureCode: string | null; failureMessage: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runEvalSuite(opts: RunOptions): Promise<RunResult> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const pollMs = opts.pollMs ?? 500;

  async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new HarnessError(`${method} ${path}: cannot reach ${base} (${(err as Error).message})`);
    }
    const text = await res.text();
    if (!res.ok) throw new HarnessError(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async function pollUntil<T>(what: string, timeoutMs: number, path: string, done: (v: T) => boolean): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await api<T>('GET', path);
      if (done(value)) return value;
      if (Date.now() > deadline) throw new HarnessError(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await sleep(pollMs);
    }
  }

  const { suite } = opts;
  const { id: documentId } = await api<{ id: string }>('POST', '/documents', {
    title: suite.document.title,
    format: suite.document.format,
    content: opts.content,
  });
  const doc = await pollUntil<DocumentStatus>(
    `document ${documentId}`,
    opts.documentTimeoutMs ?? 60_000,
    `/documents/${documentId}`,
    (d) => d.status === 'ready' || d.status === 'failed',
  );
  if (doc.status !== 'ready') throw new HarnessError(`document failed: ${doc.failureCode} ${doc.failureMessage}`);
  const stored = await api<{ content: string }>('GET', `/documents/${documentId}/content`);

  const rows: EvalRow[] = [];
  const models = new Set<string>();
  for (const chain of suite.conversations) {
    let conversationId: string | null = null;
    for (const turn of chain) {
      const started = Date.now();
      const accepted: Accepted = conversationId
        ? await api<Accepted>('POST', `/conversations/${conversationId}/messages`, { question: turn.question })
        : await api<Accepted>('POST', '/conversations', { documentId, question: turn.question });
      conversationId = accepted.conversationId;
      const answer = await pollUntil<AssistantMessage>(
        `answer to "${turn.id}"`,
        opts.answerTimeoutMs ?? 300_000,
        `/messages/${accepted.assistantMessageId}`,
        (m) => m.status === 'completed' || m.status === 'failed',
      );
      if (answer.model) models.add(answer.model);
      opts.onAnswer?.(turn.id, answer);
      const check = checkAnswer(answer, turn.expect, stored.content);
      rows.push({ id: turn.id, question: turn.question, seconds: (Date.now() - started) / 1000, ...check });
    }
  }
  return { documentId, rows, models: [...models] };
}
