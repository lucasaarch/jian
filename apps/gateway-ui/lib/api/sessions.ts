import { type Client, profile } from './params';
import { result } from './result';
import type { MediaUpload, ModelSelection, ProjectChoice, ProtectionMode } from './types';

/**
 * Sessions, messages and execution history. Gateway chats are owner-written; channel
 * conversations belong to the channel they came through.
 */
export const sessionCalls = (client: Client) => ({
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
  createGatewaySession: (
    profileId: string,
    projectId?: string | null,
    remoteMachineId?: string | null,
  ) =>
    result(
      client.POST('/v1/profiles/{profileId}/gateway-sessions', {
        params: profile(profileId),
        body: {
          ...(projectId ? { projectId } : {}),
          ...(remoteMachineId ? { remoteMachineId } : {}),
        },
      }),
    ),
  renameSession: (profileId: string, sessionId: string, title: string) =>
    result(
      client.PATCH('/v1/profiles/{profileId}/sessions/{sessionId}', {
        params: { path: { profileId, sessionId } },
        body: { title },
      }),
    ),
  messages: (profileId: string, sessionId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/messages', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  deleteSession: (profileId: string, sessionId: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/sessions/{sessionId}', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  send: (profileId: string, sessionId: string, text: string, mediaIds: string[] = []) =>
    result(
      client.POST('/v1/profiles/{profileId}/sessions/{sessionId}/messages', {
        params: { path: { profileId, sessionId } },
        // Each press is a new message; the key only stops one request from landing twice.
        body: {
          text,
          requestKey: crypto.randomUUID(),
          ...(mediaIds.length ? { mediaIds } : {}),
        },
      }),
    ),
  /** Null puts the conversation back on the profile's model defaults. */
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
    projectId: string | null,
    remoteMachineId: string | null,
  ) =>
    result(
      client.PUT('/v1/profiles/{profileId}/sessions/{sessionId}/target', {
        params: { path: { profileId, sessionId } },
        body: { projectId, remoteMachineId },
      }),
    ),
  upload: (profileId: string, sessionId: string, file: MediaUpload) =>
    result(
      client.POST('/v1/profiles/{profileId}/sessions/{sessionId}/media', {
        params: { path: { profileId, sessionId } },
        body: file,
      }),
    ),
  timeline: (profileId: string, sessionId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/timeline', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  people: (profileId: string, sessionId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/people', {
        params: { path: { profileId, sessionId } },
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
