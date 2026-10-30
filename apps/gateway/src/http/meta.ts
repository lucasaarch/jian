import { createOpenAPI } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { gatewayRelease } from '../core/release.js';

/** Unauthenticated probes: liveness and the published contract. */
export function registerMetaRoutes(app: FastifyInstance, mode: 'server' | 'local'): void {
  app.get('/health', async () => {
    // A machine's worker must share this gateway's major.minor; local/dev builds omit version.
    const version = gatewayRelease();
    return {
      status: 'ok' as const,
      service: 'jian' as const,
      ...(version ? { version } : {}),
      mode,
    };
  });

  app.get('/openapi.json', async () => createOpenAPI());
}
