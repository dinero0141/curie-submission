/** Fastify app factory. All I/O dependencies are injected so tests can use `app.inject` against real services. */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { Queues } from '../jobs/queues.js';
import { envelope, toHttpError } from './errors.js';
import { registerDocumentRoutes } from './routes/documents.js';

export type AppDeps = {
  pool: pg.Pool;
  config: Pick<Config, 'maxDocumentBytes' | 'bodyLimitBytes'>;
  queues: Pick<Queues, 'prepareDocument'>;
  /** Fastify logger option; tests pass `false`. */
  logger?: FastifyServerOptions['logger'];
  /** Max wait for an enqueue on the request path before deferring to the reconciler (default 2 s). */
  enqueueTimeoutMs?: number;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    // JSON escaping can inflate content; the exact UTF-8 byte check on `content` happens in the route.
    bodyLimit: deps.config.bodyLimitBytes,
  });

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
  return app;
}
