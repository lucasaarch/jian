'use client';

import type { TextareaHTMLAttributes } from 'react';
import { skillFields } from '../../components/skills/skill-fields';
import { TextArea, TextField } from '../../kit';
import type { Skill } from '../../lib/api';

/**
 * A skill's name and what it is for, as fields: the same two wherever a skill is written, the
 * form that creates one and the page that edits one. The library keeps a skill under its name,
 * so one that exists shows it and cannot change it.
 */
export function SkillIdentityFields({ skill }: { skill?: Skill }) {
  return (
    <>
      <TextField
        label="Name"
        name="name"
        hint={skill ? 'A skill keeps its name.' : skillFields.name.hint}
        required
        pattern={skillFields.name.pattern}
        defaultValue={skill?.name ?? ''}
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
    </>
  );
}

/** A skill's instructions as a field, held to what the gateway accepts. */
export function SkillInstructionsField(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <TextArea
      label="Instructions"
      name="instructions"
      required
      maxLength={skillFields.instructions.maxLength}
      {...props}
    />
  );
}
