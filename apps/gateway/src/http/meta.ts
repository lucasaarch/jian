import { createOpenAPI } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Unauthenticated probes: liveness and the published contract. */
export function registerMetaRoutes(app: FastifyInstance): void {
  app.get('/health', async () => {
    const stamped = process.env.JIAN_VERSION?.replace(/^v/, '');
    // Remote Control uses the same major.minor as this gateway; omit version on local/dev builds.
    const version =
      stamped && VERSION.test(stamped) && stamped !== '0.0.0-dev' ? stamped : undefined;
    return {
      status: 'ok' as const,
      service: 'jian' as const,
      ...(version ? { version } : {}),
    };
  });

  app.get('/openapi.json', async () => createOpenAPI());
}
