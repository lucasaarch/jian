'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SectionActions } from '../../components/props';
import type { NewSecret, Secret, SecretPatch } from '../../lib/api';
import { keys } from '../../lib/query/keys';

/**
 * The Secrets one agent may use, and what is done to them. A sensitive value never comes back:
 * the gateway takes one in and keeps it, and the list only says the field is there. A change
 * shows at once.
 */
export function useSecrets(
  profileId: string,
  { api, mutate }: Pick<SectionActions, 'api' | 'mutate'>,
) {
  const client = useQueryClient();
  const key = keys.secrets(profileId);
  const list = useQuery({ queryKey: key, queryFn: () => api.secrets(profileId) });
  // One no longer this agent's (handed to others alone) leaves its list.
  const put = (secret: Secret) =>
    client.setQueryData<Secret[]>(key, (current = []) =>
      [...current.filter((item) => item.id !== secret.id), secret]
        .filter((item) => item.profileIds.includes(profileId))
        .sort((a, b) => a.title.localeCompare(b.title)),
    );

  return {
    secrets: list.data ?? [],
    loading: list.isPending,
    error: list.error ? 'Could not load the Secrets.' : '',
    add: (body: NewSecret) =>
      mutate(async () => put(await api.createSecret(profileId, body)), 'Secret added.'),
    change: (secretId: string, body: SecretPatch) =>
      mutate(async () => put(await api.updateSecret(profileId, secretId, body)), 'Secret saved.'),
    remove: async (secretId: string) => {
      const done = await mutate(() => api.deleteSecret(profileId, secretId), 'Secret deleted.');
      if (done) {
        client.setQueryData<Secret[]>(key, (current = []) =>
          current.filter((item) => item.id !== secretId),
        );
      }
      return done;
    },
  };
}
