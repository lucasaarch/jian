'use client';

import { useState } from 'react';
import { skillFrom } from '../../components/skills/skill-fields';
import { Markdown } from '../../components/ui/markdown';
import { Action, Overlay, OverlayActions, surfaceCard } from '../../kit';
import type { Skill } from '../../lib/api';
import { SkillIdentityFields, SkillInstructionsField } from './skill-form-fields';

type FormProps = {
  busy: boolean;
  onSave: (skill: Skill) => void;
};

/**
 * Writes a new skill: its name, when an agent should use it and its instructions, read as
 * written or as the agents see them. One that exists is edited on its own page. `round` changes
 * on every opening, so each starts empty and nothing typed outlives a cancel.
 */
export function SkillDialog({
  open,
  onOpenChange,
  round,
  ...form
}: { open: boolean; onOpenChange: (open: boolean) => void; round: number } & FormProps) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Create a skill" size="form">
      <SkillForm key={round} {...form} onCancel={() => onOpenChange(false)} />
    </Overlay>
  );
}

function SkillForm({ busy, onSave, onCancel }: FormProps & { onCancel: () => void }) {
  const [instructions, setInstructions] = useState('');
  const [preview, setPreview] = useState(false);

  return (
    <form
      className="grid w-full gap-5 p-7"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(skillFrom(new FormData(event.currentTarget)));
      }}
    >
      <header className="grid gap-1.5 pr-10">
        <h2 className="text-lg font-semibold tracking-tight">Create a skill</h2>
        <p className="text-sm text-muted">Instructions every agent loads when it needs them.</p>
      </header>
      <SkillIdentityFields />
      {preview ? (
        <div className="grid gap-1.5">
          <span className="text-[13px] font-medium text-ink">Instructions</span>
          <div
            className={`markdown max-h-[50dvh] overflow-y-auto ${surfaceCard} px-4 py-3.5 text-sm leading-relaxed`}
          >
            <Markdown text={instructions} />
          </div>
          {/* Still sent from the preview: a hidden field is not asked to be valid. */}
          <input type="hidden" name="instructions" value={instructions} />
        </div>
      ) : (
        <SkillInstructionsField
          rows={9}
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
          Create
        </Action>
      </OverlayActions>
    </form>
  );
}
