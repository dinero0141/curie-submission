/**
 * Anthropic adapter: `AnswerRequest` → `client.messages.stream(...)` → `RawAnswer`.
 *
 * Request and response shapes follow `docs/notes/citations-spike.md` (claude-api skill + SDK 1.10.0 types).
 * They are ASSUMED, NOT observed live: this was written in a run without an API key. The SDK types check the
 * request at compile time; what the API returns is checked at runtime by `resolveCitations`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ModelRefusalError, ModelTimeoutError } from './errors.js';
import type { AnswerModel, AnswerRequest, RawAnswer } from './types.js';

/**
 * Room for adaptive thinking on top of the answer budget: thinking counts toward `max_tokens` (fact 13), so
 * `max_tokens = MAX_ANSWER_TOKENS + THINKING_HEADROOM_TOKENS`. Unused headroom costs nothing.
 */
export const THINKING_HEADROOM_TOKENS = 4096;

/**
 * Effort for grounded document Q&A. `thinking` is omitted (adaptive): it works on every current model, where
 * `between_tools` is Sonnet 5.5-only and would 400 if `ANTHROPIC_MODEL` points elsewhere. `medium` sits
 * between the skill's `low` for chat and Sonnet 5.5's default `high`; tune it with `pnpm eval`.
 */
export const ANSWER_EFFORT = 'medium' as const;

export type AnthropicParamsOptions = { model: string; maxAnswerTokens: number };

/**
 * Build the Messages API body. History is plain text in both roles; documents go only in the final user
 * message (so `document_index` is unambiguous, and neither 2026-10-21 rule on citations in user text /
 * documents in assistant turns can trigger). No `temperature`/`top_p`/`top_k` (400 on 2026-10-21), no
 * `thinking` (adaptive), no `cache_control` (prompt caching is a documented next step).
 */
export function toAnthropicParams(req: AnswerRequest, opts: AnthropicParamsOptions): Anthropic.MessageStreamParams {
  const history: Anthropic.MessageParam[] = req.history.flatMap((t): Anthropic.MessageParam[] => [
    { role: 'user', content: t.question },
    { role: 'assistant', content: t.answer },
  ]);
  const documents: Anthropic.DocumentBlockParam[] = req.documents.map((d) => ({
    type: 'document',
    title: d.title,
    source: { type: 'content', content: d.blocks.map((text): Anthropic.TextBlockParam => ({ type: 'text', text })) },
    citations: { enabled: true },
  }));
  return {
    model: opts.model,
    max_tokens: opts.maxAnswerTokens + THINKING_HEADROOM_TOKENS,
    system: req.system,
    output_config: { effort: ANSWER_EFFORT },
    messages: [...history, { role: 'user', content: [...documents, { type: 'text', text: req.userText }] }],
  };
}

/**
 * `finalMessage()` → `RawAnswer`: text blocks only, in order (thinking blocks, possibly empty, are skipped).
 * Citations are passed through untouched; `resolveCitations` checks every field.
 */
export function toRawAnswer(message: Anthropic.Message): RawAnswer {
  const blocks = message.content.flatMap((b) =>
    b.type === 'text' ? [{ text: b.text, citations: (b.citations ?? null) as readonly unknown[] | null }] : [],
  );
  if (message.stop_reason === 'refusal') {
    throw new ModelRefusalError(message.stop_details?.category ?? null, blocks.map((b) => b.text).join(''));
  }
  return { blocks, stopReason: message.stop_reason ?? 'unknown', usage: message.usage, model: message.model };
}

export type AnthropicModelOptions = {
  apiKey: string;
  model: string;
  maxAnswerTokens: number;
  timeoutMs: number;
  /** Test seam: the SDK's `fetch` option (no network in unit tests). */
  fetch?: typeof globalThis.fetch;
  baseURL?: string;
};

export class AnthropicModel implements AnswerModel {
  readonly provider = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicModelOptions) {
    // maxRetries 0: BullMQ owns retries (attempts + backoff), so one job attempt = one API call.
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 0,
      timeout: opts.timeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async generate(req: AnswerRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<RawAnswer> {
    // The SDK `timeout` bounds waiting for a response; this signal bounds the whole streamed answer.
    const deadline = AbortSignal.timeout(this.opts.timeoutMs);
    const stream = this.client.messages.stream(toAnthropicParams(req, this.opts), {
      signal: AbortSignal.any([signal, deadline]),
    });
    stream.on('text', (delta) => onDelta(delta));
    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (deadline.aborted && !signal.aborted) throw new ModelTimeoutError(this.opts.timeoutMs, { cause: err });
      throw err;
    }
    return toRawAnswer(message);
  }
}
