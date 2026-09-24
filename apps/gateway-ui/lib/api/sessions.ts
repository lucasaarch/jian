import { type Client, profile } from './params';
import { result } from './result';
import type { MediaUpload } from './types';

/**
 * Sessions, messages and execution history. Reading covers every conversation; writing only
 * the gateway conversation, since the others belong to the channel they came through.
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
  messages: (profileId: string, sessionId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/messages', {
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
  activityCalendar: (profileId: string, zone: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/activity', {
        params: { ...profile(profileId), query: { zone } },
      }),
    ),
  activities: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/activities', { params: profile(profileId) })),
});
