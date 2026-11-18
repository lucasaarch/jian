'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GatewayApi, LibrarySkill, Skill } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import type { SectionActions } from '../props';

/** How many skills the installation's library holds; the gateway refuses more. */
export const SKILL_LIMIT = 60;

/** Kept apart from the library's own key: reading the library again does not ask GitHub again. */
const upstreamKey = (name: string) => ['skill-upstream', name] as const;

/**
 * Whether an imported skill's source says something else than the library now holds. Asked when
 * its page opens and not again for ten minutes: GitHub answers a few requests an hour to a
 * gateway with no account. Never retried, so a source out of reach is said at once.
 */
export function useSkillUpstream(api: GatewayApi, name: string) {
  return useQuery({
    queryKey: upstreamKey(name),
    queryFn: () => api.skillUpstream(name),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/**
 * The installation's skill library, shared by every agent, and what changes it. Each change
 * resolves false when it failed, after saying so.
 */
export function useSkillList({ api, mutate }: Pick<SectionActions, 'api' | 'mutate'>) {
  const client = useQueryClient();
  const library = useQuery({ queryKey: keys.skills, queryFn: () => api.skills() });
  const skills = library.data ?? [];
  const error = library.error
    ? library.error instanceof Error
      ? library.error.message
      : 'Could not load.'
    : '';
  const change = (action: () => Promise<unknown>, message: string) =>
    mutate(async () => {
      await action();
      await client.invalidateQueries({ queryKey: keys.skills });
    }, message);

  const create = ({ name, description, instructions }: Skill) =>
    change(() => api.createSkill({ name, description, instructions }), 'Saved.');

  /** A skill keeps its name: an edit changes what it says, and who wrote it stays. */
  const update = (name: string, { description, instructions }: Omit<Skill, 'name'>) =>
    change(async () => {
      await api.updateSkill(name, { description, instructions });
      // An imported skill edited here no longer says what its source does: asked again, without
      // the save waiting on GitHub.
      void client.invalidateQueries({ queryKey: upstreamKey(name) });
    }, 'Saved.');

  const remove = (name: string) => change(() => api.deleteSkill(name), 'Deleted.');

  /**
   * Copies a skill, or a folder of them, from a repository address, trimmed first. Resolves with
   * what was imported, and with nothing when it failed.
   */
  const importFrom = async (url: string) => {
    let imported: LibrarySkill[] = [];
    const done = await change(async () => {
      imported = await api.importSkill(url.trim());
    }, 'Skill imported.');

    return done ? imported : undefined;
  };

  /** Copies an imported skill from its source again, over what the library holds. */
  const updateFromSource = (name: string) =>
    change(async () => {
      await api.updateSkillFromSource(name);
      // What the library holds is now what the source says, without asking GitHub again.
      client.setQueryData(upstreamKey(name), {
        changed: false,
        checkedAt: new Date().toISOString(),
      });
    }, 'Updated from its source.');

  return {
    skills,
    loading: library.isPending,
    error,
    create,
    update,
    remove,
    importFrom,
    updateFromSource,
  };
}
