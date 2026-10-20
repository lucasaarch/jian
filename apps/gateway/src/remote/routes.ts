import type { FastifyInstance } from 'fastify';
import type { Remote } from './service.js';

export function registerRemoteRoutes(app: FastifyInstance, deps: { remote: Remote }): void {
  app.get('/v1/remote/machines', async () => deps.remote.list());

  app.post('/v1/remote/machines', async (request, reply) =>
    reply.code(201).send(await deps.remote.create(request.body)),
  );

  app.patch<{ Params: { machineId: string } }>(
    '/v1/remote/machines/:machineId/access',
    async (request) => deps.remote.setAccess(request.params.machineId, request.body),
  );

  app.delete<{ Params: { machineId: string } }>('/v1/remote/machines/:machineId', async (request) =>
    deps.remote.remove(request.params.machineId),
  );

  app.get<{ Params: { machineId: string } }>(
    '/v1/remote/worker/:machineId/tasks/next',
    async (request) =>
      deps.remote.poll(
        request.params.machineId,
        request.headers.authorization ?? '',
        typeof request.headers['x-jian-platform'] === 'string'
          ? request.headers['x-jian-platform']
          : undefined,
      ),
  );

  app.post<{ Params: { machineId: string; taskId: string } }>(
    '/v1/remote/worker/:machineId/tasks/:taskId/result',
    async (request) =>
      deps.remote.complete(
        request.params.machineId,
        request.params.taskId,
        request.headers.authorization ?? '',
        request.body,
      ),
  );
}
