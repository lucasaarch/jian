'use client';

import { useState } from 'react';
import { skillFields, skillFrom } from '../../components/skills/skill-fields';
import { Action, Overlay, OverlayActions, StatusPill, TextArea, TextField } from '../../kit';
import type { Skill } from '../../lib/api';
import { SkillInstructions } from './skill-reading';

type FormProps = {
  /** The skill to configure; a new one without it. */
  skill?: Skill;
  /** Whose it is, said beside its name: "By you". A new one has none yet. */
  source?: string;
  busy: boolean;
  onSave: (skill: Skill) => void;
};

/**
 * Writes a skill, or edits one of the library's: its name, when an agent should use it and its
 * instructions, read as written or as the agents see them. `round` changes on every opening, so
 * each starts from the skill and nothing typed outlives a cancel.
 */
export function SkillDialog({
  open,
  onOpenChange,
  round,
  ...form
}: { open: boolean; onOpenChange: (open: boolean) => void; round: number } & FormProps) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={form.skill ? form.skill.name : 'Create a skill'}
      size="form"
    >
      <SkillForm key={round} {...form} onCancel={() => onOpenChange(false)} />
    </Overlay>
  );
}

function SkillForm({
  skill,
  source,
  busy,
  onSave,
  onCancel,
}: FormProps & { onCancel: () => void }) {
  const [instructions, setInstructions] = useState(skill?.instructions ?? '');
  const [preview, setPreview] = useState(false);

  return (
    <form
      className="grid w-full gap-5 p-7"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(skillFrom(new FormData(event.currentTarget), skill));
      }}
    >
      <header className="grid gap-1.5 pr-10">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <span className="truncate">{skill ? skill.name : 'Create a skill'}</span>
          {source && <StatusPill>{source}</StatusPill>}
        </h2>
        <p className="text-sm text-muted">Instructions every agent loads when it needs them.</p>
      </header>
      <TextField
        label="Name"
        name="name"
        hint={skillFields.name.hint}
        required
        pattern={skillFields.name.pattern}
        defaultValue={skill?.name ?? ''}
        // The library keeps a skill under its name: an edit changes what it says.
        readOnly={Boolean(skill)}
        autoComplete="off"
        spellCheck={false}
      />
      <TextField
        label="Description"
        name="description"
        hint={skillFields.description.hint}
        required
        maxLength={skillFields.description.maxLength}
        defaultValue={skill?.description ?? ''}
        autoComplete="off"
      />
      {preview ? (
        <div className="grid gap-1.5">
          <span className="text-[13px] font-medium text-ink">Instructions</span>
          <SkillInstructions text={instructions} />
          {/* Still sent from the preview: a hidden field is not asked to be valid. */}
          <input type="hidden" name="instructions" value={instructions} />
        </div>
      ) : (
        <TextArea
          label="Instructions"
          name="instructions"
          required
          rows={9}
          maxLength={skillFields.instructions.maxLength}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      )}
      <OverlayActions>
        <Action
          tone="outline"
          disabled={!instructions.trim()}
          onClick={() => setPreview((shown) => !shown)}
        >
          {preview ? 'Edit' : 'Preview'}
        </Action>
        <span className="flex-1" />
        <Action tone="quiet" onClick={onCancel}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy}>
          {skill ? 'Save' : 'Create'}
        </Action>
      </OverlayActions>
    </form>
  );
}
