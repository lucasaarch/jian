import { createOpenAPI } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { gatewayRelease } from '../core/release.js';

/** Unauthenticated probes: liveness and the published contract. */
export function registerMetaRoutes(app: FastifyInstance): void {
  app.get('/health', async () => {
    // Remote Control uses the same major.minor as this gateway; omit version on local/dev builds.
    const version = gatewayRelease();
    return {
      status: 'ok' as const,
      service: 'jian' as const,
      ...(version ? { version } : {}),
    };
  });

  app.get('/openapi.json', async () => createOpenAPI());
}
