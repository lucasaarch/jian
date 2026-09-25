'use client';

import type { Skill } from '../../lib/api';
import { Button, Field, Modal } from '../ui';

export function SkillForm({
  skill,
  busy,
  failed,
  onSave,
  onClose,
}: {
  skill?: Skill;
  busy: boolean;
  failed: boolean;
  onSave: (skill: Skill) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Skill"
      close={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="skill-form" busy={busy}>
            Save skill
          </Button>
        </>
      }
    >
      <form
        id="skill-form"
        method="post"
        action="/ui/"
        onSubmit={(event) => {
          event.preventDefault();

          const form = new FormData(event.currentTarget);

          onSave({
            name: String(form.get('name')),
            description: String(form.get('description')),
            instructions: String(form.get('instructions')),
            // An edit keeps who wrote it: the agent may still refine a skill of its own.
            ...(skill?.writtenBy ? { writtenBy: skill.writtenBy } : {}),
          });
        }}
      >
        <Field label="Name" hint="Lowercase letters, digits, hyphen and underscore.">
          <input name="name" required pattern="[a-z0-9_-]{1,64}" defaultValue={skill?.name ?? ''} />
        </Field>
        <Field label="Description" hint="This is how the agent decides when to use the skill.">
          <input
            name="description"
            required
            maxLength={300}
            defaultValue={skill?.description ?? ''}
          />
        </Field>
        <Field label="Instructions">
          <textarea
            name="instructions"
            required
            rows={9}
            maxLength={12000}
            defaultValue={skill?.instructions ?? ''}
          />
        </Field>
        {failed && (
          <p role="alert" className="form-error">
            Could not save. Check the fields, or refresh the profile.
          </p>
        )}
      </form>
    </Modal>
  );
}
