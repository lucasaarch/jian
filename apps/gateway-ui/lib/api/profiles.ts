import {
  effectiveProfessionSchema,
  professionCatalogSchema,
  professionPreviewSchema,
} from '@jian/contracts';
import { type Client, profile } from './params';
import { result } from './result';
import type { NewProfile, ProfilePatch } from './types';

/** The owner's own session, and the profiles the installation holds. */
export const profileCalls = (client: Client) => ({
  signIn: (token: string) => result(client.POST('/v1/panel/session', { body: { token } })),
  signOut: () => result(client.DELETE('/v1/panel/session')),
  profiles: () => result(client.GET('/v1/profiles')),
  professions: async () =>
    professionCatalogSchema.parse(await result(client.GET('/v1/professions'))),
  previewProfession: async (
    profileId: string,
    professionId: 'developer' | 'attendant',
    expectedVersion: number,
  ) =>
    professionPreviewSchema.parse(
      await result(
        client.POST('/v1/profiles/{profileId}/profession/preview', {
          params: profile(profileId),
          body: { professionId, expectedVersion },
        }),
      ),
    ),
  assignProfession: (
    profileId: string,
    professionId: 'developer' | 'attendant',
    expectedVersion: number,
  ) =>
    result(
      client.POST('/v1/profiles/{profileId}/profession/assign', {
        params: profile(profileId),
        body: { professionId, expectedVersion },
      }),
    ),
  // Parse the discriminated response at the boundary. The transport's Readable<T> helper
  // drops null-only properties from its inferred type; the canonical contract retains them.
  profileProfession: async (profileId: string) =>
    effectiveProfessionSchema.parse(
      await result(
        client.GET('/v1/profiles/{profileId}/profession', { params: profile(profileId) }),
      ),
    ),
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
