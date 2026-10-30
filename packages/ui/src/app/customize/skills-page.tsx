'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { sourceOf } from '../../components/skills/origin';
import { SKILL_LIMIT, type SkillEditing, useSkillList } from '../../components/skills/skill-list';
import {
  Action,
  ConfirmDialog,
  SettingsGroup,
  SettingsRow,
  SettingsRowsSkeleton,
  SkeletonRegion,
  StatusPill,
} from '../../kit';
import type { Skill } from '../../lib/api';
import { useActions } from '../../lib/workspace';
import { SkillBuiltinGroup, SkillBuiltinWaiting } from './skill-builtin-group';
import { SkillDialog } from './skill-dialog';
import { SkillImportDialog } from './skill-import-dialog';

/**
 * The skills while the agent is read: a few of its own, the rows that write and import another,
 * and the built-in list under them.
 */
export function SkillsWaiting() {
  return (
    <SkeletonRegion label="Loading skills…" className="grid grid-cols-1 gap-6">
      <SettingsGroup title="Installed">
        <SettingsRowsSkeleton count={4} />
      </SettingsGroup>
      <SkillBuiltinWaiting />
    </SkeletonRegion>
  );
}

/**
 * The agent's skills: its own — written here, imported, or written by itself — a line each with
 * Configure, and the ways to write or import another; then those the gateway ships, switched on
 * and off. Removing one asks for its name first.
 */
export function SkillsPage() {
  const { api, mutate, busy } = useActions();
  const { profile, skills, save, remove, importFrom } = useSkillList({ api, mutate });
  // What the form edits stays set while it closes, so it fades out as it was.
  const [editing, setEditing] = useState<SkillEditing>('new');
  const [formOpen, setFormOpen] = useState(false);
  const [round, setRound] = useState(0);
  const [importing, setImporting] = useState(false);
  // By name: once the list is saved without it, its place belongs to the next skill.
  const [removing, setRemoving] = useState('');
  const [asking, setAsking] = useState(false);
  const full = skills.length >= SKILL_LIMIT;
  const configured = editing === 'new' ? undefined : skills[editing];
  // A skill written here is the usual case; only another source is worth a word.
  const source = (skill: Skill) => {
    const { label } = sourceOf(skill, profile.name);
    return label === 'Written here' ? undefined : label;
  };

  const edit = (target: SkillEditing) => {
    setEditing(target);
    setRound((count) => count + 1);
    setFormOpen(true);
  };

  return (
    <>
      <SettingsGroup title="Installed">
        {skills.map((skill, index) => (
          <SettingsRow
            key={skill.name}
            title={
              <span className="flex items-center gap-2">
                <span className="truncate">{skill.name}</span>
                {source(skill) && <StatusPill>{source(skill)}</StatusPill>}
              </span>
            }
          >
            <Action
              tone="outline"
              size="small"
              aria-label={`Configure ${skill.name}`}
              onClick={() => edit(index)}
            >
              Configure
            </Action>
          </SettingsRow>
        ))}
        <SettingsRow
          title="Create a skill"
          {...(full
            ? { description: `An agent keeps up to ${SKILL_LIMIT}.` }
            : skills.length
              ? {}
              : { description: 'None yet.' })}
        >
          <Action tone="outline" size="small" disabled={full} onClick={() => edit('new')}>
            <Plus size={13} />
            Add
          </Action>
        </SettingsRow>
        <SettingsRow title="Import from GitHub">
          <Action tone="outline" size="small" onClick={() => setImporting(true)}>
            <Plus size={13} />
            Import
          </Action>
        </SettingsRow>
      </SettingsGroup>
      <SkillBuiltinGroup profile={profile} api={api} mutate={mutate} />
      <SkillDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        round={round}
        skill={configured}
        source={configured && source(configured)}
        busy={busy}
        onSave={(next) =>
          void save(next, editing).then((ok) => {
            if (ok) setFormOpen(false);
          })
        }
        {...(configured
          ? {
              onRemove: () => {
                setRemoving(configured.name);
                setAsking(true);
              },
            }
          : {})}
      />
      <SkillImportDialog
        open={importing}
        onOpenChange={setImporting}
        busy={busy}
        importFrom={importFrom}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${removing}?`}
        phrase={removing}
        action="Remove skill"
        busy={busy}
        run={() => {
          const index = skills.findIndex((skill) => skill.name === removing);
          if (index < 0) return;
          void remove(index).then((ok) => {
            if (!ok) return;
            setAsking(false);
            setFormOpen(false);
          });
        }}
      >
        The agent stops using it on its next runs. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
