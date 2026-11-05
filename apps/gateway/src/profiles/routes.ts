import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Worktrees } from '../worktrees/service.js';
import type { ProfileAdmin } from './port.js';
import type { Profiles } from './service.js';

type ProfileRouteServices = {
  profiles: ProfileAdmin & Pick<Profiles, 'revisions'>;
  worktrees: Pick<Worktrees, 'recordedForProfile' | 'clear'>;
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

  // Deleting or resetting takes the worktree rows with the sessions, so the folders are read
  // first and removed once it has committed. A folder that cannot go is logged, never a failure.
  const keepingNoWorktrees = async <T>(profileId: string, change: () => Promise<T>) => {
    const records = await deps.worktrees.recordedForProfile(profileId);
    const changed = await change();
    await deps.worktrees
      .clear(profileId, records)
      .catch((error) => console.warn(`Could not clean up worktrees: ${String(error)}`));
    return changed;
  };

  app.delete<{ Params: ProfileParams }>('/v1/profiles/:profileId', async (request) =>
    keepingNoWorktrees(request.params.profileId, () =>
      deps.profiles.deleteProfile(request.params.profileId),
    ),
  );

  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/reset', async (request) =>
    keepingNoWorktrees(request.params.profileId, () =>
      deps.profiles.resetProfile(request.params.profileId),
    ),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/revisions', async (request) =>
    deps.profiles.revisions(request.params.profileId),
  );
}
