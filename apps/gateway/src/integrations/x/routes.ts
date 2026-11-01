import type { FastifyInstance } from 'fastify';
import type { XIntegration } from './integration.js';

export function registerXRoutes(app: FastifyInstance, x: XIntegration) {
  app.get('/v1/integrations/x', async () => x.status());

  app.put<{ Body: { clientId: string; clientSecret: string } }>(
    '/v1/integrations/x/app',
    async (request) => x.saveApp(request.body),
  );

  app.post('/v1/integrations/x/connect', async (request) => x.start(request.headers.origin));

  // Reached by the owner's browser, with only the state to vouch for it. A failure is logged with
  // its reason, never the code or the state, and the owner is still sent back to the panel.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/v1/integrations/x/callback',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');

      const { location, failure, cause } = await x.finish(request.query);

      if (failure) {
        request.log.warn(
          { x: { reason: failure }, err: cause },
          'X account could not be connected',
        );
      }

      return reply.redirect(location, 302);
    },
  );

  app.delete<{ Params: { accountId: string } }>(
    '/v1/integrations/x/accounts/:accountId',
    async (request) => x.disconnect(request.params.accountId),
  );
}
