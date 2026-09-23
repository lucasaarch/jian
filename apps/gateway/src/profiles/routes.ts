import type { FastifyInstance } from 'fastify';
import type { McpLogins } from '../agent/mcp-login.js';
import { probeMcpServer } from '../agent/mcp-probe.js';
import { GatewayError } from '../core/errors.js';
import type { ProfileParams } from '../http/params.js';
import type { Vault } from '../security/vault.js';
import type { ProfileAdmin } from './port.js';
import type { Profiles } from './service.js';

type ProfileRouteServices = {
  profiles: ProfileAdmin & Pick<Profiles, 'revisions'>;
  vault: Vault;
  /** Absent in a gateway with no public address configured; OAuth servers then cannot sign in. */
  mcpLogins?: McpLogins;
};

/** The only HTML this gateway serves outside the panel: where a redirect lands. */
const page = (title: string, detail: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;padding:3rem"><h1>${title}</h1><p>${detail}</p>`;

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileRouteServices): void {
  app.get('/v1/profiles', async () => deps.profiles.profiles());

  app.post('/v1/profiles', async (request, reply) =>
    reply.code(201).send(await deps.profiles.createProfile(request.body)),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId', async (request) =>
    deps.profiles.profile(request.params.profileId),
  );

  app.patch<{ Params: ProfileParams }>('/v1/profiles/:profileId', async (request) =>
    deps.profiles.updateProfile(request.params.profileId, request.body),
  );

  app.delete<{ Params: ProfileParams }>('/v1/profiles/:profileId', async (request) =>
    deps.profiles.deleteProfile(request.params.profileId),
  );

  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/reset', async (request) =>
    deps.profiles.resetProfile(request.params.profileId),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/revisions', async (request) =>
    deps.profiles.revisions(request.params.profileId),
  );

  app.post<{ Params: ProfileParams & { name: string } }>(
    '/v1/profiles/:profileId/mcp-servers/:name/check',
    async (request) => {
      const { profileId, name } = request.params;

      const status = await probeMcpServer(
        await deps.profiles.profile(profileId),
        name,
        deps.vault,
        undefined,
        deps.mcpLogins?.provider,
      );

      // A server that refused because nobody has signed in yet answers with where to go.
      return deps.mcpLogins?.withAuthorization(profileId, status) ?? status;
    },
  );

  // The authorization server redirects the owner's browser here, so the answer is a page.
  app.get<{ Params: ProfileParams & { name: string }; Querystring: Record<string, string> }>(
    '/v1/profiles/:profileId/mcp-servers/:name/oauth/callback',
    async (request, reply) => {
      const { profileId, name } = request.params;

      if (!deps.mcpLogins) {
        throw new GatewayError(503, 'MCP sign-in is not configured on this gateway');
      }

      const { code, state } = request.query;

      // The state is what ties this redirect to a sign-in the owner started here; without it
      // the route is a public endpoint anyone could aim an authorization code at.
      if (!code || !state) {
        return reply.type('text/html').send(page('Sign-in refused', request.query.error ?? ''));
      }

      await deps.mcpLogins.complete(await deps.profiles.profile(profileId), name, code, state);

      return reply.type('text/html').send(page(`${name} is connected`, 'You can close this tab.'));
    },
  );
}
