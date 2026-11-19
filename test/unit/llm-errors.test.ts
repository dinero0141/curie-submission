// classifyError against real error instances from the installed @anthropic-ai/sdk (1.10.0). Error bodies follow
// the API's `{type: 'error', error: {type, message}}` envelope; the prompt-too-long wording is an assumption
// (not observed live — keyless run).
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { classifyError, ModelRefusalError, ModelTimeoutError } from '../../src/llm/errors.js';

const body = (type: string, message: string) => ({ type: 'error', error: { type, message } });
/** The SDK's own status → class mapping, as used when a real response comes back. */
const fromStatus = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, body(type, message), undefined, new Headers({ 'request-id': 'req_test' }));

describe('classifyError', () => {
  it.each([
    ['429 rate limit', fromStatus(429, 'rate_limit_error', 'Rate limited')],
    ['529 overloaded', fromStatus(529, 'overloaded_error', 'Overloaded')],
    ['500 api error', fromStatus(500, 'api_error', 'Internal server error')],
    ['503 unavailable', fromStatus(503, 'api_error', 'Service unavailable')],
    ['502 (no dedicated class)', fromStatus(502, 'api_error', 'Bad gateway')],
    ['408 request timeout', fromStatus(408, 'timeout_error', 'Request timeout')],
    ['connection error', new Anthropic.APIConnectionError({ message: 'socket hang up' })],
    ['SDK connection timeout', new Anthropic.APIConnectionTimeoutError()],
    ['our wall-clock timeout', new ModelTimeoutError(90_000)],
    ['user abort (worker shutdown)', new Anthropic.APIUserAbortError()],
    ['mid-stream overloaded event', new Anthropic.APIError(undefined, body('overloaded_error', 'Overloaded'), undefined, new Headers(), 'overloaded_error')],
    ['mid-stream error without type', new Anthropic.APIError(undefined, undefined, 'stream broke', undefined)],
    ['generic AnthropicError', new Anthropic.AnthropicError('wrapped stream failure')],
  ])('%s → retryable model_unavailable', (_name, err) => {
    expect(classifyError(err)).toMatchObject({ code: 'model_unavailable', retryable: true });
  });

  it('maps statuses to the SDK classes we rely on', () => {
    expect(fromStatus(429, 'rate_limit_error', 'x')).toBeInstanceOf(Anthropic.RateLimitError);
    expect(fromStatus(529, 'overloaded_error', 'x')).toBeInstanceOf(Anthropic.OverloadedError);
    expect(fromStatus(529, 'overloaded_error', 'x')).toBeInstanceOf(Anthropic.InternalServerError);
    expect(fromStatus(400, 'invalid_request_error', 'x')).toBeInstanceOf(Anthropic.BadRequestError);
    expect(fromStatus(401, 'authentication_error', 'x')).toBeInstanceOf(Anthropic.AuthenticationError);
    expect(new Anthropic.APIConnectionTimeoutError()).toBeInstanceOf(Anthropic.APIConnectionError);
  });

  it.each([
    ['400 prompt is too long', fromStatus(400, 'invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum')],
    ['413 request too large', fromStatus(413, 'request_too_large', 'Request exceeds the maximum allowed number of bytes')],
    ['mid-stream invalid_request prompt too long', new Anthropic.APIError(undefined, body('invalid_request_error', 'prompt is too long'), undefined, new Headers(), 'invalid_request_error')],
  ])('%s → permanent context_too_large', (_name, err) => {
    expect(classifyError(err)).toMatchObject({ code: 'context_too_large', retryable: false });
  });

  it.each([
    ['400 other', fromStatus(400, 'invalid_request_error', 'messages.0.content: document blocks must have at least one block')],
    ['401 bad key', fromStatus(401, 'authentication_error', 'invalid x-api-key')],
    ['402 billing', fromStatus(402, 'billing_error', 'credit balance too low')],
    ['403 permission', fromStatus(403, 'permission_error', 'not allowed')],
    ['404 unknown model', fromStatus(404, 'not_found_error', 'model: claude-nope')],
    ['422 unprocessable', fromStatus(422, 'invalid_request_error', 'x')],
    ['mid-stream invalid_request', new Anthropic.APIError(undefined, body('invalid_request_error', 'bad block'), undefined, new Headers(), 'invalid_request_error')],
  ])('%s → permanent model_config_error', (_name, err) => {
    expect(classifyError(err)).toMatchObject({ code: 'model_config_error', retryable: false });
  });

  it('refusal → permanent model_refused', () => {
    const c = classifyError(new ModelRefusalError('cyber'));
    expect(c).toEqual({ code: 'model_refused', retryable: false, message: 'model refused to answer (category: cyber)' });
  });

  it('unknown errors are retryable internal_error, and messages are bounded', () => {
    expect(classifyError(new TypeError('x is undefined'))).toMatchObject({ code: 'internal_error', retryable: true });
    expect(classifyError('a string')).toMatchObject({ code: 'internal_error', retryable: true, message: 'a string' });
    expect(classifyError(new Error('y'.repeat(2000))).message.length).toBeLessThanOrEqual(501);
  });
});
