import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { ProfileReader } from '../profiles/port.js';
import { professionCatalog } from './catalog.js';
import { effectiveProfession } from './effective.js';

export function registerProfessionRoutes(
  app: FastifyInstance,
  deps: { profiles: ProfileReader },
): void {
  app.get('/v1/professions', async () => ({ assignable: true, professions: professionCatalog }));

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/profession', async (request) =>
    effectiveProfession(await deps.profiles.profile(request.params.profileId)),
  );
}
