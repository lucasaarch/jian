import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { CommandSecrets } from './service.js';

type Params = { profileId: string; name: string };

/**
 * A paired phone has the owner's access to almost everything, but not to this: a key typed on a
 * phone, or swapped for another, would hand every agent's commands a credential from a device
 * that can be lost. It may see the names, as the agents themselves do.
 */
function fromPanel(request: FastifyRequest) {
  if (request.device) {
    throw new GatewayError(403, 'A paired device cannot change command secrets.');
  }
}

export function registerCommandSecretRoutes(
  app: FastifyInstance,
  deps: { commandSecrets: CommandSecrets },
): void {
  app.get<{ Params: Pick<Params, 'profileId'> }>(
    '/v1/profiles/:profileId/command-secrets',
    async (request) => deps.commandSecrets.list(request.params.profileId),
  );

  app.post<{ Params: Pick<Params, 'profileId'> }>(
    '/v1/profiles/:profileId/command-secrets',
    async (request, reply) => {
      fromPanel(request);
      return reply
        .code(201)
        .send(await deps.commandSecrets.create(request.params.profileId, request.body));
    },
  );

  app.patch<{ Params: Params }>(
    '/v1/profiles/:profileId/command-secrets/:name',
    async (request) => {
      fromPanel(request);
      return deps.commandSecrets.update(
        request.params.profileId,
        request.params.name,
        request.body,
      );
    },
  );

  app.delete<{ Params: Params }>(
    '/v1/profiles/:profileId/command-secrets/:name',
    async (request) => {
      fromPanel(request);
      return deps.commandSecrets.remove(request.params.profileId, request.params.name);
    },
  );
}
