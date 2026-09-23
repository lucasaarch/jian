import type { FastifyInstance } from 'fastify';
import type { Media } from './service.js';

export function registerMediaRoutes(app: FastifyInstance, deps: { media: Media }) {
  app.get<{ Params: { profileId: string; mediaId: string } }>(
    '/v1/profiles/:profileId/media/:mediaId',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return deps.media.read(request.params.profileId, request.params.mediaId);
    },
  );
}
