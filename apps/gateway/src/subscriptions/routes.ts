import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Subscriptions } from './service.js';

type SubscriptionParams = ProfileParams & { subscriptionId: string };

export function registerSubscriptionRoutes(
  app: FastifyInstance,
  deps: { subscriptions: Subscriptions },
) {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/subscriptions', async (request) =>
    deps.subscriptions.list(request.params.profileId),
  );

  app.post<{ Params: ProfileParams }>(
    '/v1/profiles/:profileId/subscriptions',
    async (request, reply) =>
      reply
        .code(201)
        .send(await deps.subscriptions.create(request.params.profileId, request.body, 'owner')),
  );

  app.patch<{ Params: SubscriptionParams }>(
    '/v1/profiles/:profileId/subscriptions/:subscriptionId',
    async (request) =>
      deps.subscriptions.update(
        request.params.profileId,
        request.params.subscriptionId,
        request.body,
      ),
  );

  app.delete<{ Params: SubscriptionParams }>(
    '/v1/profiles/:profileId/subscriptions/:subscriptionId',
    async (request) =>
      deps.subscriptions.remove(request.params.profileId, request.params.subscriptionId),
  );

  app.get<{ Params: SubscriptionParams }>(
    '/v1/profiles/:profileId/subscriptions/:subscriptionId/deliveries',
    async (request) =>
      deps.subscriptions.history(request.params.profileId, request.params.subscriptionId),
  );

  app.post<{ Params: { subscriptionId: string } }>(
    '/v1/hooks/github/:subscriptionId',
    async (request) => {
      // Sign over the same bytes the body was parsed from when a raw buffer is unavailable.
      const raw =
        (request as { rawBody?: Buffer }).rawBody ??
        Buffer.from(JSON.stringify(request.body ?? {}));
      return deps.subscriptions.receiveGithub(
        request.params.subscriptionId,
        request.headers,
        raw,
        (request.body ?? {}) as Record<string, unknown>,
      );
    },
  );
}
