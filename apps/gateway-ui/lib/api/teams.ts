import type { Client } from './params';
import { result } from './result';
import type { NewTeam, Team, TeamPatch } from './types';

// The UI may ship before the gateway's OpenAPI snapshot is regenerated. Keep this narrow cast at
// the client boundary; the endpoint and payload remain the confirmed gateway contract.
const call = (client: Client) =>
  client as unknown as {
    GET: (path: string) => Promise<{ data?: Team[]; error?: unknown; response: Response }>;
    POST: (
      path: string,
      options: { body: NewTeam },
    ) => Promise<{ data?: Team; error?: unknown; response: Response }>;
    PATCH: (
      path: string,
      options: { params: { path: { teamId: string } }; body: TeamPatch },
    ) => Promise<{ data?: Team; error?: unknown; response: Response }>;
    DELETE: (
      path: string,
      options: { params: { path: { teamId: string } } },
    ) => Promise<{ data?: { id: string }; error?: unknown; response: Response }>;
  };

export const teamCalls = (client: Client) => {
  const typed = call(client);
  return {
    teams: () => result(typed.GET('/v1/teams')),
    createTeam: (body: NewTeam) => result(typed.POST('/v1/teams', { body })),
    updateTeam: (teamId: string, body: TeamPatch) =>
      result(typed.PATCH('/v1/teams/{teamId}', { params: { path: { teamId } }, body })),
    deleteTeam: (teamId: string) =>
      result(typed.DELETE('/v1/teams/{teamId}', { params: { path: { teamId } } })),
  };
};
