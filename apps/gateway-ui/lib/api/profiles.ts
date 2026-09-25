import { type Client, profile } from './params';
import { result } from './result';
import type { NewProfile, ProfilePatch } from './types';

/** The owner's own session, and the profiles the installation holds. */
export const profileCalls = (client: Client) => ({
  signIn: (token: string) => result(client.POST('/v1/panel/session', { body: { token } })),
  signOut: () => result(client.DELETE('/v1/panel/session')),
  profiles: () => result(client.GET('/v1/profiles')),
  createProfile: (body: NewProfile) => result(client.POST('/v1/profiles', { body })),
  updateProfile: (profileId: string, body: ProfilePatch) =>
    result(client.PATCH('/v1/profiles/{profileId}', { params: profile(profileId), body })),
  resetProfile: (profileId: string) =>
    result(client.POST('/v1/profiles/{profileId}/reset', { params: profile(profileId) })),
  deleteProfile: (profileId: string) =>
    result(client.DELETE('/v1/profiles/{profileId}', { params: profile(profileId) })),
  importMcpServers: (profileId: string, fromProfileId: string, servers: string[]) =>
    result(
      client.POST('/v1/profiles/{profileId}/mcp-servers/import', {
        params: profile(profileId),
        body: { fromProfileId, servers },
      }),
    ),
  checkMcpServer: (profileId: string, name: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/mcp-servers/{name}/check', {
        params: { path: { profileId, name } },
      }),
    ),
});
