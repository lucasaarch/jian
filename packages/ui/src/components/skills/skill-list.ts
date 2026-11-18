'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Skill } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import type { SectionActions } from '../props';

/** How many skills the installation's library holds; the gateway refuses more. */
export const SKILL_LIMIT = 60;

/** Which skill a form edits: its place in the library, or a new one. */
export type SkillEditing = number | 'new';

/**
 * The installation's skill library, shared by every agent, and what changes it. Each change
 * resolves false when it failed, after saying so.
 */
export function useSkillList({ api, mutate }: Pick<SectionActions, 'api' | 'mutate'>) {
  const client = useQueryClient();
  const skills = useQuery({ queryKey: keys.skills, queryFn: () => api.skills() }).data ?? [];
  const change = (action: () => Promise<unknown>, message: string) =>
    mutate(async () => {
      await action();
      await client.invalidateQueries({ queryKey: keys.skills });
    }, message);

  /** A skill keeps its name: an edit changes what it says, and who wrote it stays. */
  const save = ({ name, description, instructions }: Skill, editing: SkillEditing) => {
    const held = editing === 'new' ? undefined : skills[editing];

    return change(
      () =>
        held
          ? api.updateSkill(held.name, { description, instructions })
          : api.createSkill({ name, description, instructions }),
      'Saved.',
    );
  };

  const remove = (name: string) => change(() => api.deleteSkill(name), 'Removed.');

  /** Copies a skill, or a folder of them, from a repository address; trimmed first. */
  const importFrom = (url: string) => change(() => api.importSkill(url.trim()), 'Skill imported.');

  return { skills, save, remove, importFrom };
}
