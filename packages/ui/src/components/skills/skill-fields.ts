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
  'The GitHub address of a skill, or of a folder of skills. A copy is kept here, updated when you ask.';
export const skillImportPlaceholder = 'https://github.com/owner/repository/tree/main/skills/deploy';

/** A skill from a form's named fields. */
export function skillFrom(form: FormData): Skill {
  return {
    name: String(form.get('name')),
    description: String(form.get('description')),
    instructions: String(form.get('instructions')),
  };
}

/** What a plain YAML value may not hold without quotes: a colon, a hash, a leading mark. */
const NEEDS_QUOTES = /[:#]|^[\s"'&*!|>%@`[\]{},?-]|\s$/;

/**
 * A skill as the document it is kept as, `SKILL.md`: its name, what it is for and, when its
 * source said one, its license, then the instructions.
 */
export function skillDocument(skill: Skill, license?: string): string {
  const value = (text: string) => (NEEDS_QUOTES.test(text) ? JSON.stringify(text) : text);
  const head = [
    `name: ${skill.name}`,
    `description: ${value(skill.description)}`,
    ...(license ? [`license: ${value(license)}`] : []),
  ];

  return `---\n${head.join('\n')}\n---\n\n${skill.instructions.trim()}\n`;
}
