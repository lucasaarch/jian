import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Projects } from './service.js';

export function registerProjectRoutes(app: FastifyInstance, projects: Projects): void {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/projects', async (request) =>
    projects.list(request.params.profileId),
  );
  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/projects', async (request) =>
    projects.ensure(request.params.profileId, request.body),
  );
}
