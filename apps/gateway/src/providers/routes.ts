import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { ProfileParams } from '../http/params.js';
import type { CodexLogin } from './codex/login.js';
import type { ProviderModels } from './discovery.js';
import type { ProviderAdmin } from './port.js';
import type { Providers } from './service.js';

type ProviderRouteServices = {
  providers: ProviderAdmin &
    Pick<Providers, 'createProvider' | 'revokeProvider' | 'modelDefaults' | 'setModelDefaults'>;
  codexLogin?: CodexLogin;
  providerModels?: Pick<ProviderModels, 'list'>;
};

export function registerProviderRoutes(app: FastifyInstance, deps: ProviderRouteServices): void {
  function codexLogin() {
    if (!deps.codexLogin) {
      throw new GatewayError(503, 'Codex login is unavailable');
    }

    return deps.codexLogin;
  }

  function providerModels() {
    if (!deps.providerModels) {
      throw new GatewayError(503, 'Model discovery is unavailable');
    }

    return deps.providerModels;
  }

  // Credentials belong to the installation; the model each profile picks with them does not.
  app.post('/v1/providers/openai/oauth', async () => codexLogin().start());

  app.get('/v1/providers/openai/oauth', async () => codexLogin().status());

  app.get('/v1/providers', async () => deps.providers.providers());

  app.post('/v1/providers', async (request, reply) =>
    reply.code(201).send(await deps.providers.createProvider(request.body)),
  );

  app.get<{ Params: { providerId: string } }>('/v1/providers/:providerId/models', async (request) =>
    providerModels().list(request.params.providerId),
  );

  app.delete<{ Params: { providerId: string } }>('/v1/providers/:providerId', async (request) =>
    deps.providers.revokeProvider(request.params.providerId),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/model-defaults', async (request) =>
    deps.providers.modelDefaults(request.params.profileId),
  );

  app.put<{ Params: ProfileParams }>('/v1/profiles/:profileId/model-defaults', async (request) =>
    deps.providers.setModelDefaults(request.params.profileId, request.body),
  );
}
