import type { FastifyInstance } from 'fastify';
import type { RepositoryStars } from './repository.js';
import type { ReleaseNotes } from './service.js';

export function registerReleaseRoutes(
  app: FastifyInstance,
  deps: {
    releases: Pick<ReleaseNotes, 'releases' | 'markSeen'>;
    repository: Pick<RepositoryStars, 'read'>;
  },
): void {
  app.get('/v1/releases', async () => deps.releases.releases());

  app.post('/v1/releases/seen', async () => deps.releases.markSeen());

  app.get('/v1/repository', async () => deps.repository.read());
}
