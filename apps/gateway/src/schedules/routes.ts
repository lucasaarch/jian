import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Schedules } from './service.js';

type ScheduleParams = ProfileParams & { scheduleId: string };

export function registerScheduleRoutes(app: FastifyInstance, deps: { schedules: Schedules }) {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/schedules', async (request) =>
    deps.schedules.list(request.params.profileId),
  );

  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/schedules', async (request, reply) =>
    reply
      .code(201)
      .send(await deps.schedules.create(request.params.profileId, request.body, 'owner')),
  );

  app.patch<{ Params: ScheduleParams }>(
    '/v1/profiles/:profileId/schedules/:scheduleId',
    async (request) =>
      deps.schedules.update(request.params.profileId, request.params.scheduleId, request.body),
  );

  app.delete<{ Params: ScheduleParams }>(
    '/v1/profiles/:profileId/schedules/:scheduleId',
    async (request) => deps.schedules.remove(request.params.profileId, request.params.scheduleId),
  );

  app.get<{ Params: ScheduleParams }>(
    '/v1/profiles/:profileId/schedules/:scheduleId/history',
    async (request) => deps.schedules.history(request.params.profileId, request.params.scheduleId),
  );

  app.post<{ Params: ScheduleParams }>(
    '/v1/profiles/:profileId/schedules/:scheduleId/run',
    async (request, reply) =>
      reply
        .code(202)
        .send(await deps.schedules.runNow(request.params.profileId, request.params.scheduleId)),
  );
}
