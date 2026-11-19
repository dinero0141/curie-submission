/**
 * Model failure classification. The processor (Task 9) uses `retryable` to decide between a BullMQ retry
 * and a terminal `failed` row, and stores `code` on the message.
 *
 * Classes come from the installed `@anthropic-ai/sdk` (1.10.0), checked most specific first. Status → class
 * mapping is the SDK's own (`APIError.generate`); retryable vs permanent follows the claude-api skill's error
 * table (429 / 5xx / 529 / connection errors retry; other 4xx do not).
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

export type ClassifiedError = { code: ModelErrorCode; retryable: boolean; message: string };

/** The model declined (`stop_reason: 'refusal'`). Thrown by the adapters so refusals flow through `classifyError`. */
export class ModelRefusalError extends Error {
  override readonly name = 'ModelRefusalError';
  constructor(
    readonly category: string | null,
    readonly partialText = '',
  ) {
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

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof ModelRefusalError) return result('model_refused', false, err);
  if (err instanceof ModelTimeoutError) return result('model_unavailable', true, err);
  if (err instanceof Error && err.name === 'TimeoutError') return result('model_unavailable', true, err); // AbortSignal.timeout

  // Subclasses of APIError with no HTTP status: check before the status switch.
  if (err instanceof Anthropic.APIConnectionError) return result('model_unavailable', true, err); // incl. APIConnectionTimeoutError
  if (err instanceof Anthropic.APIUserAbortError) return result('model_unavailable', true, err); // worker shutdown / job abort

  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === undefined) {
      // `event: error` inside an SSE stream: the SDK builds an APIError from the body, with `type` set.
      if (err.type === 'invalid_request_error') {
        return result(PROMPT_TOO_LONG.test(err.message) ? 'context_too_large' : 'model_config_error', false, err);
      }
      if (err.type && !RETRYABLE_TYPES.has(err.type)) return result('model_config_error', false, err);
      return result('model_unavailable', true, err);
    }
    if (err instanceof Anthropic.RateLimitError || status === 429) return result('model_unavailable', true, err);
    if (err instanceof Anthropic.InternalServerError || status >= 500) return result('model_unavailable', true, err); // 500, 503, 504, 529
    if (status === 408 || status === 409) return result('model_unavailable', true, err); // SDK retries these by default too
    if (err instanceof Anthropic.ContentTooLargeError || status === 413) return result('context_too_large', false, err);
    if (err instanceof Anthropic.BadRequestError || status === 400) {
      return result(PROMPT_TOO_LONG.test(err.message) ? 'context_too_large' : 'model_config_error', false, err);
    }
    return result('model_config_error', false, err); // 401, 402, 403, 404, 422, ...
  }

  if (err instanceof Anthropic.AnthropicError) return result('model_unavailable', true, err); // e.g. a wrapped stream failure
  return result('internal_error', true, err);
}
