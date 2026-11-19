/**
 * Model failure classification. The generate-answer processor (`src/jobs/generateAnswer.ts`) uses `retryable`
 * to decide between a BullMQ retry and a terminal `failed` row, and stores `code` on the message.
 *
 * Classes come from the installed `@anthropic-ai/sdk` (1.10.0), checked most specific first. Status → class
 * mapping is the SDK's own (`APIError.generate`); retryable vs permanent follows the claude-api skill's error
 * table (429 / 5xx / 529 / connection errors retry; other 4xx do not). Gemini errors are our own two classes
 * (`GeminiApiError`, `GeminiConnectionError`), classified by HTTP status per docs/notes/gemini-notes.md.
 */
import Anthropic from '@anthropic-ai/sdk';

export type ModelErrorCode =
  /** Transient (rate limit, overload, 5xx, network, timeout). Retry; on the final attempt the row gets this code. */
  | 'model_unavailable'
  /** The request is too large for the model's context or the API's size limit. Permanent. */
  | 'context_too_large'
  /** Bad key, no access, unknown model, invalid request shape. Permanent: retrying cannot help. */
  | 'model_config_error'
  /** `stop_reason: 'refusal'`. Permanent for this question. */
  | 'model_refused'
  /** Not a model error (a bug or an infrastructure hiccup). Retried, bounded by the job's attempts. */
  | 'internal_error';

export type ClassifiedError = {
  code: ModelErrorCode;
  retryable: boolean;
  message: string;
  /**
   * Minimum wait before the next attempt (a rate limit that needs time to clear). The job backoff
   * (`backoffDelayMs`, `src/jobs/queues.ts`) waits at least this long; absent = the normal backoff.
   */
  retryAfterMs?: number;
};

/** The model declined (`stop_reason: 'refusal'`). Thrown by the adapters so refusals flow through `classifyError`. */
export class ModelRefusalError extends Error {
  override readonly name = 'ModelRefusalError';
  constructor(readonly category: string | null) {
    super(`model refused to answer${category ? ` (category: ${category})` : ''}`);
  }
}

/** Our own wall-clock limit (`MODEL_TIMEOUT_MS`) on one whole streamed answer. */
export class ModelTimeoutError extends Error {
  override readonly name = 'ModelTimeoutError';
  constructor(
    readonly timeoutMs: number,
    options?: { cause?: unknown },
  ) {
    super(`model call exceeded ${timeoutMs} ms`, options);
  }
}

/** What `geminiApiError` read from the envelope's `details[]` (standard `google.rpc` error details). */
export type GeminiErrorDetails = {
  /** `google.rpc.RetryInfo.retryDelay` in ms, `null` when absent or unreadable. */
  retryDelayMs: number | null;
  /** A `google.rpc.QuotaFailure` violation with `quotaValue: "0"` (the model has no quota for this project). */
  quotaZero: boolean;
};

/**
 * A non-2xx response from the Gemini REST API (`GeminiModel`, `src/llm/gemini.ts`). The body is the
 * generateContent error envelope `{error: {code, message, status, details}}` (docs/notes/gemini-notes.md,
 * UNVERIFIED); `apiStatus` is its `status` string (e.g. `RESOURCE_EXHAUSTED`), `null` when the body had none.
 * Never carries the request body or the API key.
 */
export class GeminiApiError extends Error {
  override readonly name = 'GeminiApiError';
  readonly retryDelayMs: number | null;
  readonly quotaZero: boolean;
  constructor(
    readonly httpStatus: number,
    readonly apiStatus: string | null,
    apiMessage: string,
    details: Partial<GeminiErrorDetails> = {},
  ) {
    super(`Gemini API ${httpStatus}${apiStatus ? ` ${apiStatus}` : ''}: ${apiMessage}`);
    this.retryDelayMs = details.retryDelayMs ?? null;
    this.quotaZero = details.quotaZero ?? false;
  }
}

/**
 * The Gemini account cannot be used: `finishReason: PUP_LIMITED_DISABLED` (limited or disabled for Prohibited Use
 * Policy violations) on an HTTP 200. Permanent `model_config_error`: no request from this project can succeed.
 */
export class GeminiAccountError extends Error {
  override readonly name = 'GeminiAccountError';
  constructor(readonly finishReason: string) {
    super(`Gemini account limited or disabled (finishReason ${finishReason}); check the project in Google AI Studio`);
  }
}

/** The Gemini request did not produce an HTTP response (network failure, caller abort, unreadable body). */
export class GeminiConnectionError extends Error {
  override readonly name = 'GeminiConnectionError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Gemini's over-long-input 400 (INVALID_ARGUMENT). No official wording; forum reports show "The input token count
 * (N) exceeds the maximum number of tokens allowed (M)" and "the input token count is N but model only supports up
 * to M" (docs/notes/gemini-notes.md). Both name the *input* token count; an output-token limit 400 must not match.
 * A miss turns `context_too_large` into `model_config_error`: both permanent.
 */
const GEMINI_INPUT_TOO_LONG = /\binput token count\b/i;

/**
 * A 429 for a model with no quota at all for this project ("Quota exceeded for metric: …, limit: 0, model: …" in
 * forum reports; docs/notes/gemini-notes.md fact 18b). Waiting cannot help: it is a configuration problem.
 */
const GEMINI_QUOTA_ZERO = /\blimit: ?0\b(?!\.\d)/i;

/**
 * Wait before retrying a Gemini 429 that carries no `RetryInfo`: per-minute limits (RPM/TPM) need tens of seconds
 * to clear, so the 1 s / 2 s job backoff would burn every attempt inside the same window.
 */
export const GEMINI_RATE_LIMIT_RETRY_MS = 30_000;

/**
 * Longest `RetryInfo.retryDelay` still worth waiting for. Beyond it (e.g. a daily quota) the answer fails at once
 * as `model_unavailable` instead of holding the row `pending` and spending more requests later.
 */
export const GEMINI_MAX_RETRY_DELAY_MS = 120_000;

/**
 * Gemini HTTP status → class. Retry 408, 429 and 5xx (incl. 499 CANCELLED); everything else is permanent:
 * 400 INVALID_ARGUMENT / FAILED_PRECONDITION (e.g. free tier not available in the region), 401, 402 (prepay credits
 * depleted, shares RESOURCE_EXHAUSTED with 429, hence the HTTP code decides), 403, 404. A 429 waits at least its
 * `RetryInfo.retryDelay` (else `GEMINI_RATE_LIMIT_RETRY_MS`); a quota of 0 is `model_config_error`.
 */
function classifyGemini(err: GeminiApiError): ClassifiedError {
  const s = err.httpStatus;
  if (s === 429) {
    if (err.quotaZero || GEMINI_QUOTA_ZERO.test(err.message)) return result('model_config_error', false, err);
    const wait = err.retryDelayMs ?? GEMINI_RATE_LIMIT_RETRY_MS;
    if (wait > GEMINI_MAX_RETRY_DELAY_MS) return result('model_unavailable', false, err);
    return { ...result('model_unavailable', true, err), retryAfterMs: wait };
  }
  if (s === 408 || s === 499 || s >= 500) return result('model_unavailable', true, err);
  if (s === 413 || (s === 400 && GEMINI_INPUT_TOO_LONG.test(err.message))) return result('context_too_large', false, err);
  return result('model_config_error', false, err);
}

/**
 * The API has no stable `error_code` for an over-long prompt in SDK 1.10.0, so the 400 message is matched.
 * The SDK warns that wording can change; a miss only turns `context_too_large` into `model_config_error`
 * (both permanent), so the job outcome is the same.
 */
const PROMPT_TOO_LONG = /prompt is too long|too many (input )?tokens|context (window|length)|exceeds? the (maximum )?context/i;

/** `error.type` values of a mid-stream `event: error` (no HTTP status) that are worth a retry. */
const RETRYABLE_TYPES = new Set(['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error']);

const MAX_MESSAGE = 500;
const short = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s);

const result = (code: ModelErrorCode, retryable: boolean, err: unknown): ClassifiedError => ({
  code,
  retryable,
  message: short(err instanceof Error ? err.message : String(err)),
});

/** An `invalid_request_error` (HTTP 400 or mid-stream): over-long prompt, or a request we built wrong. */
const invalidRequest = (err: Error): ClassifiedError =>
  result(PROMPT_TOO_LONG.test(err.message) ? 'context_too_large' : 'model_config_error', false, err);

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof ModelRefusalError) return result('model_refused', false, err);
  if (err instanceof ModelTimeoutError) return result('model_unavailable', true, err); // our deadline (both adapters)

  // Gemini (plain fetch, no SDK): its own two classes.
  if (err instanceof GeminiConnectionError) return result('model_unavailable', true, err); // network, caller abort
  if (err instanceof GeminiApiError) return classifyGemini(err);
  if (err instanceof GeminiAccountError) return result('model_config_error', false, err);

  // Subclasses of APIError with no HTTP status: check before the status switch.
  if (err instanceof Anthropic.APIConnectionError) return result('model_unavailable', true, err); // incl. APIConnectionTimeoutError
  if (err instanceof Anthropic.APIUserAbortError) return result('model_unavailable', true, err); // worker shutdown / job abort

  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === undefined) {
      // `event: error` inside an SSE stream: the SDK builds an APIError from the body, with `type` set.
      if (err.type === 'invalid_request_error') return invalidRequest(err);
      if (err.type && !RETRYABLE_TYPES.has(err.type)) return result('model_config_error', false, err);
      return result('model_unavailable', true, err);
    }
    // The SDK picks the error class from the status (`APIError.generate`), so the status alone decides.
    if (status === 429 || status === 408 || status === 409 || status >= 500) {
      return result('model_unavailable', true, err); // 500, 503, 504, 529; 408/409 are retried by the SDK by default too
    }
    if (status === 413) return result('context_too_large', false, err);
    if (status === 400) return invalidRequest(err);
    return result('model_config_error', false, err); // 401, 402, 403, 404, 422, ...
  }

  if (err instanceof Anthropic.AnthropicError) return result('model_unavailable', true, err); // e.g. a wrapped stream failure
  return result('internal_error', true, err);
}
