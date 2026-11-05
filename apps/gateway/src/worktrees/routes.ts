import { randomUUID } from 'node:crypto';
import {
  GATEWAY_SESSION_CHANNEL,
  type SessionWorktree,
  worktreeParamsSchema,
  worktreeUpdateInputSchema,
} from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { SessionParams } from '../http/params.js';
import type { GitHubIntegrations } from '../integrations/github.js';
import type { RunWriter } from '../runs/port.js';
import type { Sessions } from '../sessions/service.js';
import { mergeBrief, pullRequestBrief, updateBrief } from './briefs.js';
import { offersWorktrees } from './offered.js';
import type { WorktreeRecord, Worktrees } from './service.js';

type WorktreeRouteServices = {
  sessions: Pick<Sessions, 'session'>;
  runs: RunWriter;
  worktrees: Pick<Worktrees, 'list' | 'recorded' | 'find' | 'remove' | 'githubRepository'>;
  github?: Pick<GitHubIntegrations, 'accounts'>;
};

type NameParams = SessionParams & { name: string };

const OPEN = ['queued', 'running', 'waiting'];

/**
 * Whether Open pull request applies: the origin is a github.com repository and the profile's
 * GitHub App is installed on its owner. Checked from what is stored, since minting a token for
 * every list would make opening a conversation wait on GitHub; the agent reports a repository the
 * installation was not granted.
 */
async function canOpenPullRequest(
  deps: WorktreeRouteServices,
  profileId: string,
  record: WorktreeRecord,
) {
  if (!deps.github) return false;
  const repository = await deps.worktrees.githubRepository(profileId, record);
  if (!repository) return false;
  const owner = repository.split('/')[0]?.toLowerCase();
  return (await deps.github.accounts()).some((account) => account.login.toLowerCase() === owner);
}

export function registerWorktreeRoutes(app: FastifyInstance, deps: WorktreeRouteServices): void {
  const base = '/v1/profiles/:profileId/sessions/:sessionId/worktrees';

  const openRun = async (profileId: string, sessionId: string) =>
    (await deps.runs.activities(profileId)).some(
      (run) => run.sessionId === sessionId && OPEN.includes(run.status),
    );

  // Ownership is the route's to check: the service looks a worktree up by both ids but does not
  // know whose conversation it is.
  const owned = async (params: SessionParams) => {
    const { profileId, sessionId } = params;
    return deps.sessions.session(profileId, sessionId);
  };

  app.get<{ Params: SessionParams }>(base, async (request) => {
    const { profileId, sessionId } = request.params;
    await owned(request.params);
    const states = await deps.worktrees.list(profileId, sessionId);
    const recorded = await deps.worktrees.recorded(profileId, sessionId);
    return Promise.all(
      states.map(async (state): Promise<SessionWorktree> => {
        const record = recorded.find((item) => item.name === state.name);
        return {
          ...state,
          pullRequest: record ? await canOpenPullRequest(deps, profileId, record) : false,
        };
      }),
    );
  });

  // The owner pressed a button: the agent does the work, and the panel shows it, not the brief.
  // A run in flight takes it as a steer. A run asked for here is never delivered on a channel,
  // but one already answering a contact would carry the work to them, so that has to finish.
  const act = (
    path: string,
    brief: (
      record: WorktreeRecord,
      request: { body: unknown },
      profileId: string,
    ) => string | Promise<string>,
    action: string,
  ) =>
    app.post<{ Params: NameParams }>(`${base}/:name/${path}`, async (request, reply) => {
      const { profileId, sessionId, name } = worktreeParamsSchema.parse(request.params);
      const session = await owned(request.params);
      const record = await deps.worktrees.find(profileId, sessionId, name);

      // The brief names worktree tools; a conversation the run gives none to must not be sent one.
      if (!offersWorktrees(session)) {
        throw new GatewayError(
          409,
          'This conversation no longer has a folder or a machine, so the agent has no worktree tools here. Give it a folder first.',
        );
      }
      if (session.channel !== GATEWAY_SESSION_CHANNEL && (await openRun(profileId, sessionId))) {
        throw new GatewayError(
          409,
          'The agent is answering this conversation. Ask again once it has finished.',
        );
      }
      return reply.code(202).send(
        await deps.runs.submit(
          profileId,
          sessionId,
          {
            text: await brief(record, request, profileId),
            requestKey: `worktree-${action}:${randomUUID()}`,
          },
          { purpose: 'resume' },
        ),
      );
    });

  act('merge', (record) => mergeBrief(record), 'merge');
  act(
    'update',
    (record, request) =>
      updateBrief(record, worktreeUpdateInputSchema.parse(request.body).strategy),
    'update',
  );
  act(
    'pull-request',
    async (record, _request, profileId) => {
      const repository = await deps.worktrees.githubRepository(profileId, record);
      if (!repository || !(await canOpenPullRequest(deps, profileId, record))) {
        throw new GatewayError(
          409,
          'A pull request needs an origin on GitHub that the connected GitHub App reaches.',
        );
      }
      return pullRequestBrief(record, repository);
    },
    'pull-request',
  );

  app.delete<{ Params: NameParams }>(`${base}/:name`, async (request, reply) => {
    const { profileId, sessionId, name } = worktreeParamsSchema.parse(request.params);
    await owned(request.params);
    await deps.worktrees.find(profileId, sessionId, name);

    // Removing the folder under a working agent would pull the ground from its next command.
    if (await openRun(profileId, sessionId)) {
      throw new GatewayError(
        409,
        'The agent is working in this conversation. Discard once it has finished.',
      );
    }
    await deps.worktrees.remove(profileId, sessionId, name, { discard: true });
    return reply.code(204).send();
  });
}
