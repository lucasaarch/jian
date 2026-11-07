import { type Client, profile } from './params';
import { GatewayAnswer, result } from './result';
import type {
  MediaUpload,
  ModelSelection,
  ProjectChoice,
  ProtectionMode,
  RequestBody,
  SessionChanges,
} from './types';

/**
 * Gateways, by origin, that refused a page `limit` on messages: they predate it, validate the
 * query strictly, and answer their latest 100 when asked for none. Asked once, then not again.
 */
const unlimited = new Set<string>();

/**
 * Sessions, messages and execution history. Gateway chats are owner-written; channel
 * conversations belong to the channel they came through. `origin` names the gateway, for what
 * the panel learns about what it accepts.
 */
export const sessionCalls = (client: Client, origin = '') => ({
  media: (profileId: string, mediaId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/media/{mediaId}', {
        params: { path: { profileId, mediaId } },
      }),
    ),
  sessions: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/sessions', { params: profile(profileId) })),
  projects: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/projects', { params: profile(profileId) })),
  /** This agent's project for a repository: opened the first time, the same one after. */
  ensureProject: (profileId: string, input: ProjectChoice) =>
    result(
      client.POST('/v1/profiles/{profileId}/projects', {
        params: profile(profileId),
        body: input,
      }),
    ),
  /** A chat, and what it works on: see `workspaceInput`. */
  createGatewaySession: (profileId: string, workspace: RequestBody<'createGatewaySession'> = {}) =>
    result(
      client.POST('/v1/profiles/{profileId}/gateway-sessions', {
        params: profile(profileId),
        body: workspace,
      }),
    ),
  setSessionPin: (profileId: string, sessionId: string, pinned: boolean) =>
    result(
      client.PUT('/v1/profiles/{profileId}/sessions/{sessionId}/pin', {
        params: { path: { profileId, sessionId } },
        body: { pinned },
      }),
    ),
  renameSession: (profileId: string, sessionId: string, title: string) =>
    result(
      client.PATCH('/v1/profiles/{profileId}/sessions/{sessionId}', {
        params: { path: { profileId, sessionId } },
        body: { title },
      }),
    ),
  /**
   * The conversation's latest messages, or the page just before one of them. A gateway that
   * refuses `limit` is asked again without it, and gives its usual page, which a reader takes as
   * it would any other.
   */
  messages: async (
    profileId: string,
    sessionId: string,
    page: { before?: string; limit?: number } = {},
  ) => {
    const read = (query: { before?: string; limit?: number }) =>
      result(
        client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/messages', {
          params: { path: { profileId, sessionId }, query },
        }),
      );
    const { limit, ...whole } = page;
    if (limit === undefined || unlimited.has(origin)) return read(whole);
    try {
      return await read(page);
    } catch (failure) {
      if (!(failure instanceof GatewayAnswer) || failure.status !== 400) throw failure;
      const answer = await read(whole);
      // Only once the same read without it worked: the refusal was of the limit, not the page.
      unlimited.add(origin);
      return answer;
    }
  },
  deleteSession: (profileId: string, sessionId: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/sessions/{sessionId}', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  send: (
    profileId: string,
    sessionId: string,
    text: string,
    mediaIds: string[] = [],
    // Each press is a new message; the key only stops one request from landing twice, and
    // a message sent again after a failure keeps its own.
    requestKey: string = crypto.randomUUID(),
    replyToId?: string,
  ) =>
    result(
      client.POST('/v1/profiles/{profileId}/sessions/{sessionId}/messages', {
        params: { path: { profileId, sessionId } },
        body: {
          text,
          requestKey,
          ...(replyToId ? { replyToId } : {}),
          ...(mediaIds.length ? { mediaIds } : {}),
        },
      }),
    ),
  /** Null puts the conversation back on the profile's model defaults. */
  react: (profileId: string, sessionId: string, messageId: string, emoji: string | null) =>
    result(
      client.PUT('/v1/profiles/{profileId}/sessions/{sessionId}/messages/{messageId}/reaction', {
        params: { path: { profileId, sessionId, messageId } },
        body: { emoji },
        signal: AbortSignal.timeout(15_000),
      }),
    ),
  setSessionModel: (profileId: string, sessionId: string, model: ModelSelection | null) =>
    result(
      client.PUT('/v1/profiles/{profileId}/sessions/{sessionId}/model', {
        params: { path: { profileId, sessionId } },
        body: { model },
      }),
    ),
  setSessionProtection: (profileId: string, sessionId: string, protection: ProtectionMode) =>
    result(
      client.PUT('/v1/profiles/{profileId}/sessions/{sessionId}/protection', {
        params: { path: { profileId, sessionId } },
        body: { protection },
      }),
    ),
  setGatewaySessionTarget: (
    profileId: string,
    sessionId: string,
    target: RequestBody<'setGatewaySessionTarget'>,
  ) =>
    result(
      client.PUT('/v1/profiles/{profileId}/sessions/{sessionId}/target', {
        params: { path: { profileId, sessionId } },
        body: target,
      }),
    ),
  upload: (profileId: string, sessionId: string, file: MediaUpload) =>
    result(
      client.POST('/v1/profiles/{profileId}/sessions/{sessionId}/media', {
        params: { path: { profileId, sessionId } },
        body: file,
      }),
    ),
  /** How full the conversation's context is and what its turns have cost. */
  context: (profileId: string, sessionId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/context', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  /** The pull requests the agent and its subagents created in a conversation, however long ago. */
  sessionPulls: (profileId: string, sessionId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/pull-requests', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  /** The conversation's isolated checkouts, and where each stands against the folder it came from. */
  sessionWorktrees: (profileId: string, sessionId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/worktrees', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  /** The four below ask the agent, which does the work: the answer is the run that was started. */
  mergeSessionWorktree: (profileId: string, sessionId: string, name: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/sessions/{sessionId}/worktrees/{name}/merge', {
        params: { path: { profileId, sessionId, name } },
      }),
    ),
  updateSessionWorktree: (
    profileId: string,
    sessionId: string,
    name: string,
    strategy: 'merge' | 'rebase' = 'merge',
  ) =>
    result(
      client.POST('/v1/profiles/{profileId}/sessions/{sessionId}/worktrees/{name}/update', {
        params: { path: { profileId, sessionId, name } },
        body: { strategy },
      }),
    ),
  openWorktreePullRequest: (profileId: string, sessionId: string, name: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/sessions/{sessionId}/worktrees/{name}/pull-request', {
        params: { path: { profileId, sessionId, name } },
      }),
    ),
  /** Removes the folder at once and keeps the branch; the gateway refuses while the agent is working. */
  discardSessionWorktree: (profileId: string, sessionId: string, name: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/sessions/{sessionId}/worktrees/{name}', {
        params: { path: { profileId, sessionId, name } },
      }),
    ),
  /** The tools of the turns named, however old; with none named, of the latest turns. */
  timeline: (profileId: string, sessionId: string, runs?: string[]) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/timeline', {
        params: {
          path: { profileId, sessionId },
          query: runs?.length ? { runs: runs.join(',') } : {},
        },
      }),
    ),
  /**
   * A project's working-tree changes; pass a listed path to read that file's diff, and `whole` for
   * the file as it is now beside it.
   */
  sessionChanges: (
    profileId: string,
    sessionId: string,
    path?: string,
    whole?: boolean,
    worktree?: string,
  ): Promise<SessionChanges> =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/changes', {
        params: {
          path: { profileId, sessionId },
          ...(path || worktree
            ? {
                query: {
                  ...(path ? { path } : {}),
                  ...(path && whole ? { whole: 'true' as const } : {}),
                  ...(worktree ? { worktree } : {}),
                },
              }
            : {}),
        },
      }),
    ),
  people: (profileId: string, sessionId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/people', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  cancelRun: (profileId: string, runId: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/runs/{runId}/cancel', {
        params: { path: { profileId, runId } },
      }),
    ),
  run: (profileId: string, runId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/runs/{runId}', {
        params: { path: { profileId, runId } },
      }),
    ),
  // Each press is its own decision; the key only stops one request from landing twice.
  decideApproval: (profileId: string, runId: string, decision: 'approve' | 'reject') =>
    result(
      client.POST('/v1/profiles/{profileId}/runs/{runId}/approval', {
        params: { path: { profileId, runId } },
        body: { decision, requestKey: crypto.randomUUID() },
      }),
    ),
  /**
   * The turn that failed, run again from where it stopped. The note is the agent's alone: it
   * says no one checked what the failed turn already did, so the agent looks before repeating.
   * One key per failed run, so a second press is the same retry.
   */
  retryRun: (profileId: string, runId: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/runs/{runId}/continue', {
        params: { path: { profileId, runId } },
        body: {
          text: 'The previous turn stopped on an error. Pick up the work where it stopped.',
          requestKey: `retry:${runId}`,
          reconciliation:
            'Not checked: the owner asked to retry after the error. Read the saved checkpoints before repeating anything the failed turn may already have done.',
        },
      }),
    ),
  /** The owner read this chat up to now; said again while it stays on screen. */
  markSessionRead: (profileId: string, sessionId: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/sessions/{sessionId}/read', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  /** Starts the chat's agent on a pull request's conflicts, from a brief the chat does not show. */
  fixGithubConflicts: (
    profileId: string,
    sessionId: string,
    { owner, repo, number }: { owner: string; repo: string; number: number },
  ) =>
    result(
      // Picked by name: callers hand over a whole pull request, and the route refuses any
      // property beyond these three.
      client.POST('/v1/profiles/{profileId}/sessions/{sessionId}/github/fix-conflicts', {
        params: { path: { profileId, sessionId } },
        body: { owner, repo, number },
      }),
    ),
  answerRun: (profileId: string, runId: string, text: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/runs/{runId}/answer', {
        params: { path: { profileId, runId } },
        body: { text, requestKey: crypto.randomUUID() },
      }),
    ),
  activityCalendar: (profileId: string, zone: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/activity', {
        params: { ...profile(profileId), query: { zone } },
      }),
    ),
  activities: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/activities', { params: profile(profileId) })),
});
