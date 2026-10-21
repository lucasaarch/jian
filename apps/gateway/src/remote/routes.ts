import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Remote } from './service.js';

/**
 * Worker script shipped as `@jian-ai/remote-control`. Resolved from the workspace (dev) or
 * the deployed tree so `/jian-remote.mjs` and `/update` stay available without cloning Jian.
 */
const require = createRequire(import.meta.url);
const workerScript = (() => {
  try {
    return require.resolve('@jian-ai/remote-control/bin/jian-remote.mjs');
  } catch {
    // Fallback for a checkout that has not linked the package yet.
    return fileURLToPath(new URL('../../../remote-control/bin/jian-remote.mjs', import.meta.url));
  }
})();

/**
 * Contract allows ~400 KiB stdout + 50 KiB stderr. Default Fastify bodyLimit is 256 KiB,
 * which produced HTTP 413 and left workers retrying forever. Match the schema with headroom.
 */
const REMOTE_RESULT_BODY_LIMIT = 512 * 1024;

export function registerRemoteRoutes(app: FastifyInstance, deps: { remote: Remote }): void {
  // Public: legacy curl installers and the worker's self-update still fetch this script.
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
