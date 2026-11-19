/** Fastify app factory. All I/O dependencies are injected so tests can use `app.inject` against real services. */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { Queues } from '../jobs/queues.js';
import { envelope, toHttpError } from './errors.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerMessageRoutes } from './routes/messages.js';

export type AppDeps = {
  pool: pg.Pool;
  config: Pick<Config, 'maxDocumentBytes' | 'bodyLimitBytes'>;
  queues: Pick<Queues, 'prepareDocument' | 'generateAnswer'>;
  /** Fastify logger option; tests pass `false`. */
  logger?: FastifyServerOptions['logger'];
  /** Max wait for an enqueue on the request path before deferring to the reconciler (default `ENQUEUE_TIMEOUT_MS`, 2 s). */
  enqueueTimeoutMs?: number;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    // JSON escaping can inflate content; the exact UTF-8 byte check on `content` happens in the route.
    bodyLimit: deps.config.bodyLimitBytes,
  });

  // JSON only: Fastify's default text/plain parser would turn a plain-text body into a 400 "not an object"
  // instead of the documented 415.
  app.removeContentTypeParser('text/plain');

  app.setErrorHandler((err, req, reply) => {
    const { error, internal } = toHttpError(err);
    if (internal) req.log.error({ err }, 'unhandled error');
    return reply.code(error.statusCode).send(envelope(error.code, error.message));
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(envelope('not_found', `route ${req.method} ${req.url} not found`)),
  );

  app.get('/health', async () => ({ ok: true }));
  registerDocumentRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerMessageRoutes(app, deps);
  return app;
}
