'use client';

import { useState } from 'react';
import { useBuiltinSkills, useSkillSwitches } from '../../components/skills/built-in-skills';
import { skillItems } from '../../components/skills/skill-items';
import { SKILL_LIMIT, useSkillList } from '../../components/skills/skill-list';
import type { Skill } from '../../lib/api';
import { skillPath } from '../../lib/navigation';
import { useAgents } from '../../lib/query/agent';
import { useActions, useProfileId } from '../../lib/workspace';
import { useRouter } from '../../platform/navigation';
import { SkillDialog } from './skill-dialog';
import { SkillImportDialog } from './skill-import-dialog';

/**
 * The installation's skills, the library every agent shares and those the gateway ships, drawn
 * alike, with the switch that offers one to every agent and what changes the library. Shared by
 * Plugins, which lists them, and by the page of one.
 */
export function useSkills() {
  const { api, mutate, busy } = useActions();
  const library = useSkillList({ api, mutate });
  const builtIn = useBuiltinSkills(api);
  const { enabled, flip } = useSkillSwitches([...library.skills, ...builtIn.skills], {
    api,
    mutate,
  });
  const agents = useAgents();
  const items = skillItems(
    library.skills,
    builtIn.skills,
    (id) => agents.find((agent) => agent.id === id)?.name,
    enabled,
  );

  return {
    api,
    busy,
    library,
    items,
    flip,
    loading: library.loading || builtIn.loading,
    error: library.error || builtIn.error,
  };
}

/**
 * What Plugins does with the skills: a row opens the skill's own page, and Add writes a new one
 * or imports. Both end on the page of what they added, when that is one skill. The two forms are
 * drawn by `SkillOverlays`, given what this returns.
 */
export function usePluginSkills() {
  const { busy, library, items, loading, error } = useSkills();
  const profileId = useProfileId();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [round, setRound] = useState(0);
  const [importing, setImporting] = useState(false);
  const open = (name: string) => {
    if (profileId) router.push(skillPath(profileId, name));
  };

  return {
    items,
    loading,
    error,
    /** The library holds no more: nothing new can be written until one is deleted. */
    full: library.skills.length >= SKILL_LIMIT,
    show: (key: string) => {
      const item = items.find((candidate) => candidate.key === key);
      if (item) open(item.name);
    },
    create: () => {
      setRound((count) => count + 1);
      setCreating(true);
    },
    startImport: () => setImporting(true),
    overlays: {
      busy,
      form: {
        open: creating,
        onOpenChange: setCreating,
        round,
        onSave: (next: Skill) =>
          void library.create(next).then((ok) => {
            if (!ok) return;
            setCreating(false);
            open(next.name);
          }),
      },
      importing,
      setImporting,
      importFrom: async (url: string) => {
        const imported = await library.importFrom(url);
        // A folder of them stays on the list, where all of them are.
        if (imported?.length === 1 && imported[0]) open(imported[0].name);

        return Boolean(imported);
      },
    },
  };
}

/** What opens over Plugins for a skill: the form that writes a new one, and the import. */
export function SkillOverlays({
  busy,
  form,
  importing,
  setImporting,
  importFrom,
}: ReturnType<typeof usePluginSkills>['overlays']) {
  return (
    <>
      <SkillDialog {...form} busy={busy} />
      <SkillImportDialog
        open={importing}
        onOpenChange={setImporting}
        busy={busy}
        importFrom={importFrom}
      />
    </>
  );
}
