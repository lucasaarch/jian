import type { UpdateComponent } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import type { GatewayUpdates } from './service.js';

export function registerUpdateRoutes(
  app: FastifyInstance,
  deps: {
    updates: Pick<GatewayUpdates, 'status' | 'update' | 'saveWebhook' | 'removeWebhook'>;
  },
): void {
  // A webhook's path, parameter values and header values go in and never come back out: the
  // status names only its origin, its method and the names of its parameters and headers.
  app.get('/v1/updates', async () => deps.updates.status());

  app.post('/v1/updates/check', async () => deps.updates.status(true));

  app.post('/v1/updates', async (request) => deps.updates.update(request.body));

  app.put<{ Params: { component: UpdateComponent } }>(
    '/v1/updates/webhooks/:component',
    async (request) => deps.updates.saveWebhook(request.params.component, request.body),
  );

  app.delete<{ Params: { component: UpdateComponent } }>(
    '/v1/updates/webhooks/:component',
    async (request) => deps.updates.removeWebhook(request.params.component),
  );
}
