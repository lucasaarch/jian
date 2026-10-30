'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { NewProfile, Profile } from './api';
import { panelApi } from './query/client';
import { queries } from './query/profile';

/** Both entry points create once and publish the saved identity to every agent chooser. */
export function useCreateProfile(created: (profile: Profile) => void) {
  const client = useQueryClient();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async (input: NewProfile) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const profile = await panelApi().createProfile(input);
      // Cancel an older list before publishing: it must not erase the newly created agent.
      await client.cancelQueries({ queryKey: queries.profiles().queryKey });
      created(profile);
      client.setQueryData(queries.profiles().queryKey, (profiles = []) => [
        ...profiles.filter((item) => item.id !== profile.id),
        profile,
      ]);
      void client.invalidateQueries({ queryKey: queries.profiles().queryKey });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The agent could not be created.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return { create, busy, error };
}
