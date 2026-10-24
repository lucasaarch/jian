import { timingSafeEqual } from 'node:crypto';
import { operations } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { GatewayError } from '../core/errors.js';
import { authorizesPanel } from '../security/panel-session.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    workerAuth?: boolean;
  }
}

/**
 * The host token is the only API credential: it opens the whole installation. Unknown routes
 * require it, public routes carry their own proof, and webhook adapters authenticate the
 * secret of their own channel binding.
 */
export function configureSecurity(app: FastifyInstance, options: { token: string }) {
  app.addHook('onRequest', async (request, reply) => {
    // Only the static-file plugin sets this flag; API routes still require bearer authentication.
    if (request.routeOptions.config.publicUiAsset && ['GET', 'HEAD'].includes(request.method)) {
      return;
    }
    if (request.routeOptions.config.workerAuth) return;

    const operation = operations.find(
      (item) => item.path === request.routeOptions.url && item.method === request.method,
    );

    if (operation?.access === 'public' || operation?.access === 'webhook') {
      return;
    }

    const authorization = request.headers.authorization ?? '';

    if (authorization.length > 512) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const supplied = Buffer.from(authorization);
    const expected = Buffer.from(`Bearer ${options.token}`);

    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      return;
    }

    // The panel trades the host token for a signed cookie, so its requests carry no bearer.
    if (!authorization && authorizesPanel(request, options.token)) {
      return;
    }

    return reply.code(401).send({ error: 'Unauthorized' });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'Invalid request',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    if (error instanceof GatewayError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
      });
    }

    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;

    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'Invalid request' });
    }

    app.log.error({ event: 'request.failed' }, 'Request failed');

    return reply.code(500).send({ error: 'Internal server error' });
  });
}
