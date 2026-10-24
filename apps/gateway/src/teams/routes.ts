import type { TeamInput } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import type { Teams } from './service.js';

type TeamParams = { teamId: string };

export function registerTeamRoutes(app: FastifyInstance, teams: Teams): void {
  app.get('/v1/teams', async () => teams.list());
  app.post('/v1/teams', async (request, reply) =>
    reply.code(201).send(await teams.create(request.body as TeamInput)),
  );
  app.patch<{ Params: TeamParams }>('/v1/teams/:teamId', async (request) =>
    teams.update(request.params.teamId, request.body as TeamInput),
  );
  app.delete<{ Params: TeamParams }>('/v1/teams/:teamId', async (request) =>
    teams.remove(request.params.teamId),
  );
}
