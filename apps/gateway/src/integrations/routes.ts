import type { GitHubMergeMethod } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import type { GitHubIntegrations, GitHubReturnPath } from './github.js';
import type { GitHubItems } from './github-items.js';

type ItemParams = { owner: string; repo: string; number: number };

export function registerIntegrationRoutes(
  app: FastifyInstance,
  github: GitHubIntegrations,
  items: GitHubItems,
) {
  app.get<{ Params: ItemParams }>('/v1/integrations/github/pulls/:owner/:repo/:number', (request) =>
    items.pull(request.params),
  );

  app.get<{ Params: ItemParams }>(
    '/v1/integrations/github/issues/:owner/:repo/:number',
    (request) => items.issue(request.params),
  );

  app.post<{ Body: { urls: string[] } }>('/v1/integrations/github/links', (request) =>
    items.links(request.body.urls),
  );

  app.post<{
    Params: ItemParams;
    Body: { method: GitHubMergeMethod; expectedHeadSha: string; profileId?: string };
  }>('/v1/integrations/github/pulls/:owner/:repo/:number/merge', (request) =>
    items.merge(request.params, request.body, (message, error) =>
      request.log.warn({ err: error }, message),
    ),
  );

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

  // GitHub has installed the App by the time it comes back here, so a failure is logged with its
  // reason — never the code or the state — and the owner is still sent back to the panel.
  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      installation_id?: number;
      setup_action?: string;
      error?: string;
    };
  }>('/v1/integrations/github/callback', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const {
      code,
      state,
      installation_id: installationId,
      setup_action: setupAction,
    } = request.query;
    const context = { installationId, setupAction };

    if (request.query.error || !code || !state || !installationId) {
      const reason = request.query.error ? 'denied' : 'incomplete';
      request.log.warn(
        {
          github: {
            ...context,
            reason,
            error: request.query.error,
            code: Boolean(code),
            state: Boolean(state),
          },
        },
        'GitHub came back without an authorized installation',
      );
      return reply.redirect(await github.failedRedirect(state, reason), 302);
    }
    try {
      const { location, failure } = await github.finish(state, code, installationId);
      if (failure) {
        request.log.warn(
          { github: { ...context, reason: failure.reason }, err: failure },
          'GitHub installation could not be connected',
        );
      }
      return reply.redirect(location, 302);
    } catch (error) {
      request.log.warn(
        { github: { ...context, reason: 'gateway' }, err: error },
        'GitHub installation could not be connected',
      );
      return reply.redirect(await github.failedRedirect(state, 'gateway'), 302);
    }
  });

  app.get('/v1/integrations/github/repositories', async () => github.allRepositories());

  app.delete<{ Params: { accountId: string } }>(
    '/v1/integrations/github/installations/:accountId',
    async (request) => github.disconnect(request.params.accountId),
  );
}
