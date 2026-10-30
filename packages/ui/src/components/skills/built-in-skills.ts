'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { GatewayApi, Profile } from '../../lib/api';
import { keys } from '../../lib/query/keys';

/**
 * The skills that ship with the gateway, as this agent has them. Keyed by the profile's version:
 * a switch, flipped here or by the agent, changes which are enabled.
 */
export function useBuiltinSkills(profile: Profile, api: GatewayApi) {
  const builtIn = useQuery({
    queryKey: [...keys.builtinSkills(profile.id), profile.version],
    queryFn: () => api.builtinSkills(profile.id),
    placeholderData: keepPreviousData,
  });
  const error = builtIn.error
    ? builtIn.error instanceof Error
      ? builtIn.error.message
      : 'Could not load.'
    : '';

  return { skills: builtIn.data ?? [], loading: builtIn.isPending, error };
}

/**
 * The profile change that switches one built-in skill on or off. It is made against the version
 * on screen, so a change the agent made meanwhile is refused rather than overwritten.
 */
export function switchBuiltinSkill(profile: Profile, name: string, on: boolean) {
  return {
    expectedVersion: profile.version,
    disabledSkills: on
      ? profile.disabledSkills.filter((item) => item !== name)
      : [...profile.disabledSkills, name],
  };
}

export const switchedMessage = (name: string, on: boolean) =>
  on ? `${name} switched on.` : `${name} switched off.`;
