/** Request validation shared by the routes: ids, zod errors, text Postgres can store unchanged. */
import type { z } from 'zod';
import { HttpError, notFound } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A UTF-16 surrogate without its pair: cannot be stored as UTF-8, so offsets would drift. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** NUL is rejected by Postgres `text` (which would be a 500). */
export const hasNul = (s: string) => s.includes('\u0000');
/** An unpaired surrogate is silently rewritten to U+FFFD by Postgres. */
export const hasLoneSurrogate = (s: string) => LONE_SURROGATE_RE.test(s);

/** True when Postgres can store `s` unchanged (no NUL, no unpaired surrogate). Applied to every stored text field. */
export const isStorableText = (s: string) => !hasNul(s) && !hasLoneSurrogate(s);

/** Unknown or malformed ids are both a 404 (a malformed uuid would otherwise be a Postgres 22P02 → 500). */
export function parseId(id: string, what: string): string {
  if (!UUID_RE.test(id)) throw notFound(what);
  return id;
}

/** First zod issue as a 400; field schemas carry their own messages (which name the field). */
export function invalidRequest(err: z.ZodError): HttpError {
  const first = err.issues[0];
  const message = !first
    ? 'invalid request body'
    : first.path.length === 0
      ? 'request body must be a JSON object'
      : first.message;
  return new HttpError(400, 'invalid_request', message);
}
