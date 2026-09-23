import type { FastifyInstance } from 'fastify';
import type { WebSearch } from './service.js';

export function registerWebRoutes(
  app: FastifyInstance,
  deps: { web: Pick<WebSearch, 'status' | 'configure' | 'remove'> },
): void {
  // The key goes in and never comes back out: the answer says only whether one is set.
  app.get('/v1/web-search', async () => deps.web.status());

  app.put('/v1/web-search', async (request) => deps.web.configure(request.body));

  app.delete('/v1/web-search', async () => deps.web.remove());
}
