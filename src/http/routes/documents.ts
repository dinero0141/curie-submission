/**
 * Document routes. Upload only stores the row and enqueues preparation (202); chunking runs in the worker.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getDocument,
  getDocumentSummary,
  insertDocument,
  listDocuments,
  type DocumentSummary,
} from '../../db/documents.js';
import { enqueueOrDefer, enqueuePrepareDocument } from '../../jobs/queues.js';
import type { AppDeps } from '../app.js';
import { HttpError, notFound } from '../errors.js';

export const MAX_TITLE_LENGTH = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A UTF-16 surrogate without its pair: cannot be stored as UTF-8, so offsets would drift. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * True when Postgres can store `s` unchanged: no NUL (rejected by Postgres, which would be a 500) and no
 * unpaired surrogate (silently rewritten to U+FFFD). Applied to every stored text field.
 */
export const isStorableText = (s: string) => !s.includes('\u0000') && !LONE_SURROGATE_RE.test(s);

const CreateDocumentBody = z.object({
  title: z
    .string({ error: 'title must be a string' })
    .trim()
    .min(1, 'title must not be empty')
    .max(MAX_TITLE_LENGTH, `title must be at most ${MAX_TITLE_LENGTH} characters`)
    .refine(isStorableText, 'title must not contain NUL characters or unpaired UTF-16 surrogates'),
  format: z.enum(['markdown', 'text'], { error: "format must be 'markdown' or 'text'" }),
  content: z.string({ error: 'content must be a string' }),
});

/** Public JSON shape of a document (no content). */
export function documentJson(d: DocumentSummary) {
  return {
    id: d.id,
    title: d.title,
    format: d.format,
    status: d.status,
    utf16Length: d.utf16Length,
    passageCount: d.passageCount,
    failureCode: d.failureCode,
    failureMessage: d.failureMessage,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    readyAt: d.readyAt?.toISOString() ?? null,
  };
}

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

export function registerDocumentRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/documents', async (req, reply) => {
    const parsed = CreateDocumentBody.safeParse(req.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    const { title, format, content } = parsed.data;

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > deps.config.maxDocumentBytes) {
      throw new HttpError(
        413,
        'document_too_large',
        `content is ${bytes} bytes; the limit is ${deps.config.maxDocumentBytes} bytes (UTF-8)`,
      );
    }
    if (content.trim() === '') throw new HttpError(400, 'empty_document', 'content must not be empty');
    if (content.includes('\u0000')) {
      throw new HttpError(400, 'invalid_content', 'content must not contain NUL characters');
    }
    if (LONE_SURROGATE_RE.test(content)) {
      throw new HttpError(400, 'invalid_content', 'content contains an unpaired UTF-16 surrogate');
    }

    const doc = await insertDocument(deps.pool, { title, format, content });
    await enqueueOrDefer(
      enqueuePrepareDocument(deps.queues.prepareDocument, doc.id),
      deps.enqueueTimeoutMs ?? 2_000,
      req.log,
      { documentId: doc.id },
      'prepare-document',
    );
    return reply.code(202).send({ id: doc.id, status: doc.status });
  });

  app.get('/documents', async () => {
    const docs = await listDocuments(deps.pool);
    return { documents: docs.map(documentJson) };
  });

  app.get<{ Params: { id: string } }>('/documents/:id', async (req) => {
    const doc = await getDocumentSummary(deps.pool, parseId(req.params.id, 'document'));
    if (!doc) throw notFound('document');
    return documentJson(doc);
  });

  /** The exact stored content: every offset in the API is a UTF-16 index into this string. */
  app.get<{ Params: { id: string } }>('/documents/:id/content', async (req) => {
    const doc = await getDocument(deps.pool, parseId(req.params.id, 'document'));
    if (!doc) throw notFound('document');
    return { id: doc.id, format: doc.format, utf16Length: doc.utf16Length, content: doc.content };
  });
}
