import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { ProfileAdmin } from './port.js';
import type { Profiles } from './service.js';

type ProfileRouteServices = {
  profiles: ProfileAdmin & Pick<Profiles, 'revisions'>;
};

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileRouteServices): void {
  app.get('/v1/profiles', async () => deps.profiles.profiles());

  app.post('/v1/profiles', async (request, reply) =>
    reply.code(201).send(await deps.profiles.createProfile(request.body)),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId', async (request) =>
    deps.profiles.profile(request.params.profileId),
  );

  app.patch<{ Params: ProfileParams }>('/v1/profiles/:profileId', async (request) =>
    deps.profiles.updateProfile(request.params.profileId, request.body),
  );

  app.delete<{ Params: ProfileParams }>('/v1/profiles/:profileId', async (request) =>
    deps.profiles.deleteProfile(request.params.profileId),
  );

  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/reset', async (request) =>
    deps.profiles.resetProfile(request.params.profileId),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/revisions', async (request) =>
    deps.profiles.revisions(request.params.profileId),
  );
}
