import type { FastifyInstance } from 'fastify';
import type { ReleaseNotes } from './service.js';

export function registerReleaseRoutes(
  app: FastifyInstance,
  deps: { releases: Pick<ReleaseNotes, 'releases' | 'markSeen'> },
): void {
  app.get('/v1/releases', async () => deps.releases.releases());

  app.post('/v1/releases/seen', async () => deps.releases.markSeen());
}
