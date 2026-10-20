import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Remote } from './service.js';

/** Shipped next to the gateway package so a machine can download it without cloning Jian. */
const workerScript = fileURLToPath(new URL('../../bin/jian-remote.mjs', import.meta.url));

export function registerRemoteRoutes(app: FastifyInstance, deps: { remote: Remote }): void {
  // Public: the panel's install one-liner curls this before it has a worker token.
  app.get<{ Params: { machineId: string } }>(
    '/v1/remote/worker/:machineId/update',
    { config: { workerAuth: true } },
    async (request, reply) => {
      await deps.remote.workerUpdateAuthorized(
        request.params.machineId,
        request.headers.authorization ?? '',
      );
      if (!existsSync(workerScript))
        return reply.code(404).send({ error: 'Worker script not found' });
      const script = readFileSync(workerScript);
      const etag = `"${createHash('sha256').update(script).digest('hex')}"`;
      if (request.headers['if-none-match'] === etag)
        return reply.code(304).header('ETag', etag).send();
      return reply
        .type('text/javascript; charset=utf-8')
        .header('ETag', etag)
        .header('Cache-Control', 'no-cache')
        .send(script);
    },
  );

  app.get('/jian-remote.mjs', { config: { publicUiAsset: true } }, async (_request, reply) => {
    if (!existsSync(workerScript)) {
      return reply.code(404).send({ error: 'Worker script not found' });
    }

    return reply
      .type('text/javascript; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="jian-remote.mjs"')
      .header('Cache-Control', 'no-cache')
      .send(readFileSync(workerScript));
  });

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
