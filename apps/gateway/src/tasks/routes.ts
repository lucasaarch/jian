import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Work } from './service.js';

export function registerWorkRoutes(app: FastifyInstance, deps: { work: Work }) {
  app.get<{ Params: ProfileParams & { sessionId: string } }>(
    '/v1/profiles/:profileId/sessions/:sessionId/subagents',
    async (request) =>
      deps.work.conversationSubagents(request.params.profileId, request.params.sessionId),
  );
}
