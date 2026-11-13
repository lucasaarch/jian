'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { GatewayApi, Profile } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import type { SectionActions } from '../props';

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
function switchBuiltinSkill(profile: Profile, name: string, on: boolean) {
  return {
    expectedVersion: profile.version,
    disabledSkills: on
      ? profile.disabledSkills.filter((item) => item !== name)
      : [...profile.disabledSkills, name],
  };
}

const switchedMessage = (name: string, on: boolean) =>
  on ? `${name} switched on.` : `${name} switched off.`;

/**
 * Which built-in skills are on, and the switch. A switch moves the moment it is pressed, while
 * the gateway is told; refused, it goes back to what the agent holds, and the refusal is said.
 */
export function useBuiltinSwitches(
  profile: Profile,
  { api, mutate }: Pick<SectionActions, 'api' | 'mutate'>,
) {
  // What was pressed and not yet answered, over what the agent last said.
  const [pressed, setPressed] = useState<Record<string, boolean>>({});

  // From the profile, not the list: the profile is read again before an answered switch lets go,
  // while the list is fetched after it, and would show the old value for a moment.
  const enabled = (name: string) => pressed[name] ?? !profile.disabledSkills.includes(name);

  const flip = async (name: string, on: boolean) => {
    setPressed((current) => ({ ...current, [name]: on }));
    await mutate(
      () => api.updateProfile(profile.id, switchBuiltinSkill(profile, name, on)),
      switchedMessage(name, on),
    );
    setPressed(({ [name]: _settled, ...rest }) => rest);
  };

  return { enabled, flip };
}
