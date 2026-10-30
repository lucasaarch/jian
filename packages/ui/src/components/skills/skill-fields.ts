import type { Skill } from '../../lib/api';

/** The bounds the gateway puts on a skill's fields, for a form to hold to before it is sent. */
export const skillFields = {
  name: {
    pattern: '[a-z0-9_-]{1,64}',
    hint: 'Lowercase letters, digits, hyphen and underscore.',
  },
  description: {
    maxLength: 300,
    hint: 'This is how the agent decides when to use the skill.',
  },
  instructions: { maxLength: 12000 },
} as const;

/** What a skill import asks for, and what it does with it. */
export const skillImportHint =
  'The GitHub address of a skill, or of a folder of skills. The instructions are copied once.';
export const skillImportPlaceholder = 'https://github.com/owner/repository/tree/main/skills/deploy';

/**
 * A skill from a form's named fields. An edit keeps who wrote it: the agent may still refine a
 * skill of its own.
 */
export function skillFrom(form: FormData, previous?: Skill): Skill {
  return {
    name: String(form.get('name')),
    description: String(form.get('description')),
    instructions: String(form.get('instructions')),
    ...(previous?.writtenBy ? { writtenBy: previous.writtenBy } : {}),
  };
}
