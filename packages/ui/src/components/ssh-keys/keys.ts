'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SshKey } from '../../lib/api';
import { keys as cache } from '../../lib/query/keys';
import type { SectionActions } from '../props';

/**
 * The gateway's SSH keys and what is done to them, for every screen that shows them. A key
 * added or removed shows at once, before the reload that follows every action.
 */
export function useSshKeys({ api, mutate }: Pick<SectionActions, 'api' | 'mutate'>) {
  const client = useQueryClient();
  // Read through the section's own client, which a story hands in.
  const list = useQuery({ queryKey: cache.sshKeys, queryFn: () => api.sshKeys() });
  const setKeys = (change: (current: SshKey[]) => SshKey[]) =>
    client.setQueryData<SshKey[]>(cache.sshKeys, (current = []) => change(current));

  return {
    keys: list.data ?? [],
    loading: list.isPending,
    error: list.error ? 'Could not load SSH keys.' : '',
    /** The key made, with its public part; undefined when it failed and the failure was shown. */
    create: async (name: string) => {
      const label = name.trim();
      if (!label) return undefined;
      let created: SshKey | undefined;
      const done = await mutate(async () => {
        const result = await api.createSshKey({ name: label });
        created = result;
        setKeys((current) => [...current, result]);
      }, 'SSH key created.');
      return done ? created : undefined;
    },
    remove: async (key: SshKey) => {
      const done = await mutate(() => api.deleteSshKey(key.id), 'SSH key deleted.');
      if (done) setKeys((current) => current.filter((item) => item.id !== key.id));
      return done;
    },
  };
}
