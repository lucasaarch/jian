import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { Secrets } from './service.js';

type Params = { profileId: string; secretId: string };

const byOwner = { kind: 'owner' } as const;

/**
 * A paired phone has the owner's access to almost everything, but not to this: a key typed on a
 * phone, or swapped for another, would hand every agent's commands a credential from a device
 * that can be lost. It may see the Secrets, as the agents themselves do.
 */
function fromPanel(request: FastifyRequest) {
  if (request.device) {
    throw new GatewayError(403, 'A paired device cannot change Secrets.');
  }
}

export function registerSecretRoutes(app: FastifyInstance, deps: { secrets: Secrets }): void {
  app.get<{ Params: Pick<Params, 'profileId'> }>(
    '/v1/profiles/:profileId/secrets',
    async (request) => deps.secrets.list(request.params.profileId),
  );

  app.post<{ Params: Pick<Params, 'profileId'> }>(
    '/v1/profiles/:profileId/secrets',
    async (request, reply) => {
      fromPanel(request);
      return reply
        .code(201)
        .send(await deps.secrets.create(request.params.profileId, request.body, byOwner));
    },
  );

  app.patch<{ Params: Params }>('/v1/profiles/:profileId/secrets/:secretId', async (request) => {
    fromPanel(request);
    return deps.secrets.update(
      request.params.profileId,
      request.params.secretId,
      request.body,
      byOwner,
    );
  });

  app.delete<{ Params: Params }>('/v1/profiles/:profileId/secrets/:secretId', async (request) => {
    fromPanel(request);
    return deps.secrets.remove(request.params.profileId, request.params.secretId, byOwner);
  });
}
