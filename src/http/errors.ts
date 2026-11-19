/** HTTP errors and the `{ "error": { "code", "message" } }` envelope used by every error response. */

export type ErrorEnvelope = { error: { code: string; message: string } };

export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function envelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

export function notFound(what: string): HttpError {
  return new HttpError(404, 'not_found', `${what} not found`);
}

/** Fastify's own errors (body parsing, limits) mapped to stable codes; anything unknown → 500. */
const FASTIFY_CODES: Record<string, { status: number; code: string; message?: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'payload_too_large', message: 'request body is too large' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: 'unsupported_media_type',
    message: 'send the request body as application/json',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'invalid_json', message: 'request body is empty' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'invalid_json', message: 'request body is not valid JSON' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, code: 'invalid_request', message: 'invalid content-length' },
};

/** Convert anything thrown in a handler to an `HttpError`; `internal` tells the caller to log it. */
export function toHttpError(err: unknown): { error: HttpError; internal: boolean } {
  if (err instanceof HttpError) return { error: err, internal: false };
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  const known = typeof e.code === 'string' ? FASTIFY_CODES[e.code] : undefined;
  if (known) {
    return { error: new HttpError(known.status, known.code, known.message ?? String(e.message)), internal: false };
  }
  // JSON.parse SyntaxErrors surface with statusCode 400 and no FST code.
  if (err instanceof SyntaxError && e.statusCode === 400) {
    return { error: new HttpError(400, 'invalid_json', 'request body is not valid JSON'), internal: false };
  }
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return {
      error: new HttpError(e.statusCode, 'invalid_request', typeof e.message === 'string' ? e.message : 'bad request'),
      internal: false,
    };
  }
  return { error: new HttpError(500, 'internal_error', 'internal server error'), internal: true };
}
