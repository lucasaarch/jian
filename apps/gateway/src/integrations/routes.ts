import type { FastifyInstance } from 'fastify';
import type { GitHubIntegrations, GitHubReturnPath } from './github.js';

export function registerIntegrationRoutes(app: FastifyInstance, github: GitHubIntegrations) {
  app.get('/v1/integrations/github', async () => github.status());

  app.post<{ Body: { returnPath: GitHubReturnPath } }>(
    '/v1/integrations/github/manifest',
    async (request) => github.registration(request.headers.origin, request.body.returnPath),
  );

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/v1/integrations/github/manifest/callback',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!request.query.code || !request.query.state) {
        return reply.redirect(await github.failedRedirect(request.query.state), 302);
      }
      return reply.redirect(
        await github.registerFromManifest(request.query.state, request.query.code),
        302,
      );
    },
  );

  app.post<{ Body: { returnPath: GitHubReturnPath } }>(
    '/v1/integrations/github/install',
    async (request) => github.start(request.headers.origin ?? '', request.body.returnPath),
  );

  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      installation_id?: number;
      error?: string;
    };
  }>('/v1/integrations/github/callback', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (
      request.query.error ||
      !request.query.code ||
      !request.query.state ||
      !request.query.installation_id
    ) {
      return reply.redirect(await github.failedRedirect(request.query.state), 302);
    }
    try {
      return reply.redirect(
        await github.finish(request.query.state, request.query.code, request.query.installation_id),
        302,
      );
    } catch {
      return reply.redirect(await github.failedRedirect(request.query.state), 302);
    }
  });

  app.get<{ Params: { accountId: string } }>(
    '/v1/integrations/github/installations/:accountId/repositories',
    async (request) => github.repositories(request.params.accountId),
  );

  app.delete<{ Params: { accountId: string } }>(
    '/v1/integrations/github/installations/:accountId',
    async (request) => github.disconnect(request.params.accountId),
  );
}
