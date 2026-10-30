import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Stats } from './service.js';

export function registerStatsRoutes(app: FastifyInstance, deps: { stats: Stats }): void {
  app.get<{ Params: ProfileParams; Querystring: unknown }>(
    '/v1/profiles/:profileId/stats',
    async (request) => deps.stats.stats(request.params.profileId, request.query),
  );
  // Shared by every agent, and cached by the reader: cheap enough for a bar that asks often.
  app.get('/v1/subscription-usage', async () => deps.stats.subscriptions());
}
