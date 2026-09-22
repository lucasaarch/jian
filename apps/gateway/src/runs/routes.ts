import type { FastifyInstance } from 'fastify';
import type { ProfileParams, RunParams } from '../http/params.js';
import type { RunLifecycle } from './lifecycle.js';
import type { RunReader } from './port.js';
import type { Runs } from './service.js';

type RunRouteServices = {
  runs: RunReader & Pick<Runs, 'cancel' | 'continueRun' | 'recent' | 'activity'>;
  lifecycle: Pick<RunLifecycle, 'checkpoints'>;
  // The runtime holds the in-process abort handle; cancelling the record alone cannot reach it.
  onCancel?: (runId: string) => void;
};

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteServices): void {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/activities', async (request) =>
    deps.runs.recent(request.params.profileId),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/activity', async (request) =>
    deps.runs.activity(request.params.profileId),
  );

  app.get<{ Params: RunParams }>('/v1/profiles/:profileId/runs/:runId', async (request) =>
    deps.runs.run(request.params.profileId, request.params.runId),
  );

  app.post<{ Params: RunParams }>('/v1/profiles/:profileId/runs/:runId/cancel', async (request) => {
    const result = await deps.runs.cancel(request.params.profileId, request.params.runId);

    deps.onCancel?.(result.id);

    return result;
  });

  app.get<{ Params: RunParams }>(
    '/v1/profiles/:profileId/runs/:runId/checkpoints',
    async (request) => deps.lifecycle.checkpoints(request.params.profileId, request.params.runId),
  );

  app.post<{ Params: RunParams }>(
    '/v1/profiles/:profileId/runs/:runId/continue',
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await deps.runs.continueRun(request.params.profileId, request.params.runId, request.body),
        ),
  );
}
