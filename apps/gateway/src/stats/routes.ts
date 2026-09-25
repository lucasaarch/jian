import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Stats } from './service.js';

export function registerStatsRoutes(app: FastifyInstance, deps: { stats: Stats }): void {
  app.get<{ Params: ProfileParams; Querystring: unknown }>(
    '/v1/profiles/:profileId/stats',
    async (request) => deps.stats.stats(request.params.profileId, request.query),
  );
}
