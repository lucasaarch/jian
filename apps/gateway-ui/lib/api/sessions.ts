import { type Client, profile } from './params';
import { result } from './result';

/** Read-only access to sessions, messages and execution history. */
export const sessionCalls = (client: Client) => ({
  sessions: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/sessions', { params: profile(profileId) })),
  messages: (profileId: string, sessionId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/messages', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  run: (profileId: string, runId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/runs/{runId}', {
        params: { path: { profileId, runId } },
      }),
    ),
  activityCalendar: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/activity', { params: profile(profileId) })),
  activities: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/activities', { params: profile(profileId) })),
});
