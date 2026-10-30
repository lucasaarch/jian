import { randomUUID } from 'node:crypto';
import { GATEWAY_SESSION_CHANNEL, githubFixConflictsInputSchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import type { Coordination } from '../coordination/service.js';
import { GatewayError } from '../core/errors.js';
import type { ProfileParams, SessionParams } from '../http/params.js';
import { conflictsBrief } from '../integrations/github-items.js';
import type { RunWriter } from '../runs/port.js';
import type { SessionWriter } from './port.js';
import type { Sessions } from './service.js';

type SessionRouteServices = {
  sessions: SessionWriter &
    Pick<
      Sessions,
      | 'createGatewaySession'
      | 'deleteSession'
      | 'renameSession'
      | 'setModel'
      | 'setProtection'
      | 'setGatewayTarget'
      | 'setObjective'
      | 'overview'
      | 'timeline'
      | 'markRead'
    >;
  runs: RunWriter;
  // History spans every message of a profile or a session, so it comes from coordination.
  coordination: Pick<Coordination, 'history'>;
};

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteServices): void {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/sessions', async (request) =>
    deps.sessions.overview(request.params.profileId),
  );

  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/sessions', async (request, reply) =>
    reply.code(201).send(await deps.sessions.createSession(request.params.profileId, request.body)),
  );

  app.post<{ Params: ProfileParams }>(
    '/v1/profiles/:profileId/gateway-sessions',
    async (request, reply) =>
      reply
        .code(201)
        .send(await deps.sessions.createGatewaySession(request.params.profileId, request.body)),
  );

  app.patch<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId',
    async (request) =>
      deps.sessions.renameSession(request.params.profileId, request.params.sessionId, request.body),
  );

  app.delete<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId',
    async (request) =>
      deps.sessions.deleteSession(request.params.profileId, request.params.sessionId),
  );

  app.put<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/target',
    async (request) =>
      deps.sessions.setGatewayTarget(
        request.params.profileId,
        request.params.sessionId,
        request.body,
      ),
  );

  app.put<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/model',
    async (request) =>
      deps.sessions.setModel(request.params.profileId, request.params.sessionId, request.body),
  );

  app.put<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/protection',
    async (request) =>
      deps.sessions.setProtection(request.params.profileId, request.params.sessionId, request.body),
  );

  app.put<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/objective',
    async (request) =>
      deps.sessions.setObjective(request.params.profileId, request.params.sessionId, request.body),
  );

  app.post<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/read',
    (request) => deps.sessions.markRead(request.params.profileId, request.params.sessionId),
  );

  // Pressed in the Inspector of any conversation: the agent starts on it at once, and the
  // panel shows its work, not the brief. A run asked for here is never delivered on a channel,
  // so a contact does not receive it; but a run already answering a contact would read the
  // brief between its steps and carry the work to them, so that has to finish first.
  app.post<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/github/fix-conflicts',
    async (request, reply) => {
      const { profileId, sessionId } = request.params;
      const pull = githubFixConflictsInputSchema.parse(request.body);
      const session = await deps.sessions.session(profileId, sessionId);

      if (session.channel !== GATEWAY_SESSION_CHANNEL) {
        const answering = (await deps.runs.activities(profileId)).some(
          (run) =>
            run.sessionId === sessionId && ['queued', 'running', 'waiting'].includes(run.status),
        );
        if (answering) {
          throw new GatewayError(
            409,
            'The agent is answering this conversation. Ask again once it has finished.',
          );
        }
      }
      return reply
        .code(202)
        .send(
          await deps.runs.submit(
            profileId,
            sessionId,
            { text: conflictsBrief(pull), requestKey: `fix-conflicts:${randomUUID()}` },
            { purpose: 'resume' },
          ),
        );
    },
  );

  app.get<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/messages',
    async (request) => deps.sessions.messages(request.params.profileId, request.params.sessionId),
  );

  app.post<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/messages',
    async (request, reply) =>
      reply.code(202).send(
        await deps.runs.submit(request.params.profileId, request.params.sessionId, request.body, {
          ownerMessage: true,
        }),
      ),
  );

  app.get<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/history',
    async (request) =>
      deps.coordination.history(request.params.profileId, request.params.sessionId, request.query),
  );

  app.get<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/timeline',
    async (request) => deps.sessions.timeline(request.params.profileId, request.params.sessionId),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/history', async (request) =>
    deps.coordination.history(request.params.profileId, undefined, request.query),
  );
}
