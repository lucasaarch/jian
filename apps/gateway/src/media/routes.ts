import { MAX_MEDIA_BYTES } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import type { SessionParams } from '../http/params.js';
import type { Media } from './service.js';

/** The largest file, base64-encoded, plus room for the rest of the JSON around it. */
const UPLOAD_BODY_LIMIT = Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 64 * 1024;

export function registerMediaRoutes(app: FastifyInstance, deps: { media: Media }) {
  app.get<{ Params: { profileId: string; mediaId: string } }>(
    '/v1/profiles/:profileId/media/:mediaId',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return deps.media.read(request.params.profileId, request.params.mediaId);
    },
  );

  app.post<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/media',
    { bodyLimit: UPLOAD_BODY_LIMIT },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await deps.media.upload(request.params.profileId, request.params.sessionId, request.body),
        ),
  );
}
