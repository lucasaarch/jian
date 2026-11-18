'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { BuiltinSkill, GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import type { SectionActions } from '../props';

/** The skills that ship with the gateway, each with whether the installation has it on. */
export function useBuiltinSkills(api: GatewayApi) {
  const builtIn = useQuery({
    queryKey: keys.builtinSkills,
    queryFn: () => api.builtinSkills(),
    placeholderData: keepPreviousData,
  });
  const error = builtIn.error
    ? builtIn.error instanceof Error
      ? builtIn.error.message
      : 'Could not load.'
    : '';

  return { skills: builtIn.data ?? [], loading: builtIn.isPending, error };
}

const switchedMessage = (name: string, on: boolean) =>
  on ? `${name} switched on.` : `${name} switched off.`;

/**
 * Which built-in skills are on, for every agent, and the switch. A switch moves the moment it
 * is pressed, while the gateway is told; refused, it goes back to what the gateway holds, and
 * the refusal is said.
 */
export function useBuiltinSwitches(
  skills: BuiltinSkill[],
  { api, mutate }: Pick<SectionActions, 'api' | 'mutate'>,
) {
  const client = useQueryClient();
  // What was pressed and not yet answered, over what the gateway last said.
  const [pressed, setPressed] = useState<Record<string, boolean>>({});

  const enabled = (name: string) =>
    pressed[name] ?? skills.find((skill) => skill.name === name)?.enabled ?? true;

  const flip = async (name: string, on: boolean) => {
    setPressed((current) => ({ ...current, [name]: on }));
    await mutate(
      async () => {
        await api.setSkillEnabled(name, on);
        // Read again before the press lets go, or the switch would show the old value a moment.
        await client.invalidateQueries({ queryKey: keys.builtinSkills });
      },
      switchedMessage(name, on),
    );
    setPressed(({ [name]: _settled, ...rest }) => rest);
  };

  return { enabled, flip };
}
