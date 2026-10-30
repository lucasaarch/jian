'use client';

import type { Skill } from '../../lib/api';
import { useAgent } from '../../lib/query/agent';
import type { SectionActions } from '../props';

/** How many skills of its own an agent keeps; the gateway refuses more. */
export const SKILL_LIMIT = 20;

/** Which skill a form edits: its place in the agent's list, or a new one. */
export type SkillEditing = number | 'new';

/**
 * The open agent's own skills and what changes them. The list is saved whole, against the
 * version on screen, so an agent that edited its skills meanwhile is not overwritten. Each change
 * resolves false when it failed, after saying so.
 */
export function useSkillList({ api, mutate }: Pick<SectionActions, 'api' | 'mutate'>) {
  const profile = useAgent();
  const skills = profile.skills;
  const replace = (next: Skill[], message: string) =>
    mutate(
      () => api.updateProfile(profile.id, { expectedVersion: profile.version, skills: next }),
      message,
    );

  const save = (next: Skill, editing: SkillEditing) =>
    replace(
      editing === 'new'
        ? [...skills, next]
        : skills.map((item, index) => (index === editing ? next : item)),
      'Saved.',
    );

  const remove = (index: number) =>
    replace(
      skills.filter((_, at) => at !== index),
      'Removed.',
    );

  /** Copies a skill, or a folder of them, from a repository address; trimmed first. */
  const importFrom = (url: string) =>
    mutate(() => api.importSkill(profile.id, url.trim()), 'Skill imported.');

  return { profile, skills, save, remove, importFrom };
}
