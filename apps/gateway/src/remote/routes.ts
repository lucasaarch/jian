import type { FastifyInstance } from 'fastify';
import type { Remote } from './service.js';

/**
 * Contract allows ~400 KiB stdout + 50 KiB stderr. Default Fastify bodyLimit is 256 KiB,
 * which produced HTTP 413 and left workers retrying forever. Match the schema with headroom.
 */
const REMOTE_RESULT_BODY_LIMIT = 512 * 1024;

export function registerRemoteRoutes(app: FastifyInstance, deps: { remote: Remote }): void {
  app.get('/v1/remote/machines', async () => deps.remote.list());

  app.post('/v1/remote/machines', async (request, reply) =>
    reply.code(201).send(await deps.remote.create(request.body)),
  );

  app.post<{ Params: { machineId: string } }>(
    '/v1/remote/machines/:machineId/rotate',
    async (request) => deps.remote.rotate(request.params.machineId),
  );

  // The owner, from the panel: no agent asked, so the task belongs to no profile.
  app.post<{ Params: { machineId: string } }>(
    '/v1/remote/machines/:machineId/update',
    async (request) => deps.remote.update(null, request.params.machineId),
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
        typeof request.headers['x-jian-remote-capabilities'] === 'string'
          ? request.headers['x-jian-remote-capabilities']
          : undefined,
        typeof request.headers['x-jian-remote-ui-state'] === 'string'
          ? request.headers['x-jian-remote-ui-state']
          : undefined,
        typeof request.headers['x-jian-remote-version'] === 'string'
          ? request.headers['x-jian-remote-version']
          : undefined,
        typeof request.headers['x-jian-system'] === 'string'
          ? request.headers['x-jian-system']
          : undefined,
      ),
  );

  // A worker that stops says so, so the panel shows it offline at once instead of after the
  // presence window runs out.
  app.post<{ Params: { machineId: string } }>(
    '/v1/remote/worker/:machineId/disconnect',
    async (request) =>
      deps.remote.disconnect(request.params.machineId, request.headers.authorization ?? ''),
  );

  app.post<{ Params: { machineId: string; taskId: string } }>(
    '/v1/remote/worker/:machineId/tasks/:taskId/result',
    { bodyLimit: REMOTE_RESULT_BODY_LIMIT },
    async (request) =>
      deps.remote.complete(
        request.params.machineId,
        request.params.taskId,
        request.headers.authorization ?? '',
        request.body,
      ),
  );
}
