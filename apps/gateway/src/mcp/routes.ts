import type { FastifyInstance } from 'fastify';
import type { McpLogins } from '../agent/mcp-login.js';
import { GatewayError } from '../core/errors.js';
import type { McpServers } from './service.js';

type McpRouteServices = {
  mcp: McpServers;
  /** Absent in a gateway with no public address configured; OAuth servers then cannot sign in. */
  mcpLogins?: McpLogins;
  /**
   * The gateway's guarded client. The check must reach a server the way a run does, private
   * origins the operator allowed included, or it reports failures a run would not have.
   */
  fetcher?: typeof globalThis.fetch;
};

type ServerParams = { name: string };

/** The only HTML this gateway serves outside the panel: where a redirect lands. */
const page = (title: string, detail: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;padding:3rem"><h1>${title}</h1><p>${detail}</p>`;

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteServices): void {
  app.get('/v1/mcp-servers', async () => deps.mcp.list());

  app.put('/v1/mcp-servers', async (request) => deps.mcp.replace(request.body));

  app.post('/v1/mcp-servers/check', async (request) =>
    deps.mcp.checkDraft(request.body, deps.fetcher, deps.mcpLogins),
  );

  app.post<{ Params: ServerParams }>('/v1/mcp-servers/:name/check', async (request) => {
    const status = await deps.mcp.check(
      request.params.name,
      deps.fetcher,
      deps.mcpLogins?.provider,
    );

    // A server that refused because nobody has signed in yet answers with where to go.
    return deps.mcpLogins?.withAuthorization(status) ?? status;
  });

  // Read by an authorization server, not by the owner. It names a server whether or not one is
  // saved under that name: telling which exist would be the only thing it gave away.
  app.get<{ Params: ServerParams }>(
    '/v1/mcp-servers/:name/oauth/client',
    async (request, reply) => {
      const document = deps.mcpLogins?.clientDocument(request.params.name);

      if (!document) {
        throw new GatewayError(404, 'This gateway has no HTTPS address to sign in from');
      }

      // What one address answers never changes, as the address and the callback in it come from
      // the same JIAN_PUBLIC_URL, so a server may keep it a while instead of asking each sign-in.
      return reply.header('cache-control', 'public, max-age=3600').send(document);
    },
  );

  // The authorization server redirects the owner's browser here, so the answer is a page.
  app.get<{ Params: ServerParams; Querystring: Record<string, string> }>(
    '/v1/mcp-servers/:name/oauth/callback',
    async (request, reply) => {
      const { name } = request.params;

      if (!deps.mcpLogins) {
        throw new GatewayError(503, 'MCP sign-in is not configured on this gateway');
      }

      const { code, state } = request.query;

      // The state is what ties this redirect to a sign-in the owner started here; without it
      // the route is a public endpoint anyone could aim an authorization code at.
      if (!code || !state) {
        return reply.type('text/html').send(page('Sign-in refused', request.query.error ?? ''));
      }

      await deps.mcpLogins.complete(await deps.mcp.server(name), code, state);

      return reply.type('text/html').send(page(`${name} is connected`, 'You can close this tab.'));
    },
  );
}
