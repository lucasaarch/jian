import type { GitHubMergeMethod } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import type { GitHubInstallMode, GitHubIntegrations, GitHubReturnPath } from './github.js';
import { APPROVED_PAGE, APPROVED_PAGE_POLICY } from './github-approved.js';
import type { GitHubItems } from './github-items.js';

type ItemParams = { owner: string; repo: string; number: number };

export function registerIntegrationRoutes(
  app: FastifyInstance,
  github: GitHubIntegrations,
  items: GitHubItems,
  /** Whether GitHub's webhook reaches this gateway, to connect an approved request by itself. */
  options: { webhook: boolean },
) {
  app.get<{ Params: ItemParams }>('/v1/integrations/github/pulls/:owner/:repo/:number', (request) =>
    items.pull(request.params),
  );

  app.get<{ Params: ItemParams }>(
    '/v1/integrations/github/pulls/:owner/:repo/:number/file',
    (request) => items.pullFile(request.params, request.query),
  );

  app.post<{
    Params: ItemParams;
    Body: { expectedHeadSha: string };
  }>('/v1/integrations/github/pulls/:owner/:repo/:number/update-branch', (request) =>
    items.updateBranch(request.params, request.body.expectedHeadSha),
  );

  app.post<{
    Params: ItemParams;
    Body: { expectedHeadSha: string };
  }>('/v1/integrations/github/pulls/:owner/:repo/:number/ready-for-review', (request) =>
    items.markReady(request.params, request.body.expectedHeadSha),
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

  app.post<{ Body: { returnPath: GitHubReturnPath; mode?: GitHubInstallMode } }>(
    '/v1/integrations/github/install',
    async (request) =>
      github.start(request.headers.origin ?? '', request.body.returnPath, request.body.mode),
  );

  // GitHub may have installed the App, or sent an organization's owners a request for it, by the
  // time it comes back here, so a failure is logged with its reason — never the code or the
  // state — and the owner is still sent back to the panel. Only the state, which this gateway's
  // owner got from `start`, lets anything be connected: the address is public, and so is the App.
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

    // An owner approving a member's request comes back with the installation and no state, as
    // does anyone installing the App from GitHub. They may not be signed in to this panel.
    if (!request.query.error && !state && installationId) {
      request.log.info({ github: context }, 'GitHub installed the App without a Jian request');
      return reply
        .type('text/html; charset=utf-8')
        .header('content-security-policy', APPROVED_PAGE_POLICY)
        .send(APPROVED_PAGE);
    }
    const requested = setupAction === 'request';
    if (request.query.error || !state || (!code && !requested)) {
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
      // A request has no installation yet; a code with none is a sign-in to find the ones the
      // user reaches, which `authorize` asks for.
      const { location, failure } = requested
        ? await github.requested(state, code, options.webhook)
        : code && installationId
          ? await github.finish(state, code, installationId)
          : await github.connectReachable(state, code ?? '');
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
