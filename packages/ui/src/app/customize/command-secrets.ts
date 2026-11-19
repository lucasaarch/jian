'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SectionActions } from '../../components/props';
import type { CommandSecret, CommandSecretPatch, NewCommandSecret } from '../../lib/api';
import { keys } from '../../lib/query/keys';

/**
 * One agent's command secrets and what is done to them. What comes back is never a value: the
 * gateway takes one in and keeps it, and the list only says it is there. A change shows at once.
 */
export function useCommandSecrets(
  profileId: string,
  { api, mutate }: Pick<SectionActions, 'api' | 'mutate'>,
) {
  const client = useQueryClient();
  const key = keys.commandSecrets(profileId);
  const list = useQuery({ queryKey: key, queryFn: () => api.commandSecrets(profileId) });
  // One no longer this agent's (handed to others alone) leaves its list.
  const put = (secret: CommandSecret) =>
    client.setQueryData<CommandSecret[]>(key, (current = []) =>
      [...current.filter((item) => item.name !== secret.name), secret]
        .filter((item) => item.profileIds.includes(profileId))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );

  return {
    secrets: list.data ?? [],
    loading: list.isPending,
    error: list.error ? 'Could not load the command secrets.' : '',
    add: (body: NewCommandSecret) =>
      mutate(async () => put(await api.createCommandSecret(profileId, body)), 'Secret added.'),
    change: (name: string, body: CommandSecretPatch) =>
      mutate(
        async () => put(await api.updateCommandSecret(profileId, name, body)),
        body.value ? 'Secret replaced.' : 'Secret saved.',
      ),
    remove: async (name: string) => {
      const done = await mutate(() => api.deleteCommandSecret(profileId, name), 'Secret deleted.');
      if (done) {
        client.setQueryData<CommandSecret[]>(key, (current = []) =>
          current.filter((item) => item.name !== name),
        );
      }
      return done;
    },
  };
}
