'use client';

import { useState } from 'react';
import { useBuiltinSkills, useSkillSwitches } from '../../components/skills/built-in-skills';
import { type SkillItem, skillItems } from '../../components/skills/skill-items';
import { SKILL_LIMIT, type SkillEditing, useSkillList } from '../../components/skills/skill-list';
import { ConfirmDialog } from '../../kit';
import type { Skill } from '../../lib/api';
import { useAgents } from '../../lib/query/agent';
import { useActions } from '../../lib/workspace';
import { SkillDialog } from './skill-dialog';
import { SkillImportDialog } from './skill-import-dialog';
import { SkillReadingDialog } from './skill-reading';

/**
 * The installation's skills for Plugins, the library every agent shares and those the gateway
 * ships, and what the screen does with them: open one to read, write a new one, import. What
 * opens is drawn by `SkillOverlays`, given what this returns.
 */
export function usePluginSkills() {
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
  // The skill open, kept while its dialog closes and after it is deleted; read again from the
  // list while it is there, since a switch or a save changes it under the dialog.
  const [kept, setKept] = useState<SkillItem>();
  const [reading, setReading] = useState(false);
  // What the form edits stays set while it closes, so it fades out as it was.
  const [editing, setEditing] = useState<SkillEditing>('new');
  const [formOpen, setFormOpen] = useState(false);
  const [round, setRound] = useState(0);
  const [importing, setImporting] = useState(false);
  // By name: once the library is saved without it, its place belongs to the next skill.
  const [deleting, setDeleting] = useState('');
  const [asking, setAsking] = useState(false);

  const edit = (target: SkillEditing) => {
    setEditing(target);
    setRound((count) => count + 1);
    setFormOpen(true);
  };

  return {
    items,
    loading: library.loading || builtIn.loading,
    error: library.error || builtIn.error,
    /** The library holds no more: nothing new can be written until one is deleted. */
    full: library.skills.length >= SKILL_LIMIT,
    show: (key: string) => {
      const item = items.find((candidate) => candidate.key === key);
      if (!item) return;
      setKept(item);
      setReading(true);
    },
    create: () => edit('new'),
    startImport: () => setImporting(true),
    overlays: {
      busy,
      item: items.find((item) => item.key === kept?.key) ?? kept,
      reading,
      setReading,
      flip,
      edit,
      ask: (name: string) => {
        setDeleting(name);
        setAsking(true);
      },
      form: {
        open: formOpen,
        onOpenChange: setFormOpen,
        round,
        skill: editing === 'new' ? undefined : library.skills[editing],
        source: editing === 'new' ? undefined : items.find((item) => item.index === editing)?.by,
        onSave: (next: Skill) =>
          void library.save(next, editing).then((ok) => {
            if (ok) setFormOpen(false);
          }),
      },
      importing,
      setImporting,
      importFrom: library.importFrom,
      deleting,
      asking,
      setAsking,
      remove: () =>
        void library.remove(deleting).then((ok) => {
          if (!ok) return;
          setAsking(false);
          setFormOpen(false);
          setReading(false);
        }),
    },
  };
}

/**
 * What opens over Plugins for a skill: the one being read, the form that writes or edits one,
 * the import, and the question before one is deleted, which asks for its name.
 */
export function SkillOverlays({
  busy,
  item,
  reading,
  setReading,
  flip,
  edit,
  ask,
  form,
  importing,
  setImporting,
  importFrom,
  deleting,
  asking,
  setAsking,
  remove,
}: ReturnType<typeof usePluginSkills>['overlays']) {
  return (
    <>
      <SkillReadingDialog
        item={item}
        open={reading}
        onOpenChange={setReading}
        busy={busy}
        onSwitch={(target, on) => void flip(target.name, on)}
        onEdit={(target) => target.index !== undefined && edit(target.index)}
        onDelete={(target) => ask(target.name)}
      />
      <SkillDialog {...form} busy={busy} />
      <SkillImportDialog
        open={importing}
        onOpenChange={setImporting}
        busy={busy}
        importFrom={importFrom}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Delete ${deleting}?`}
        phrase={deleting}
        action="Delete skill"
        busy={busy}
        run={remove}
      >
        Every agent stops using it on its next runs. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
