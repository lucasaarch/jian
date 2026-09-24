import type { Skill } from '@jian/contracts';

/**
 * Offered only to a profile with self-management on: without it the tools it describes do not
 * exist.
 */
export const managingYourself: Skill = {
  name: 'managing-yourself',
  description:
    'Use before changing your own identity or skills, or creating a profile: when each is the right place, and how to write a skill that gets used.',
  instructions: `# Changing yourself

The owner let this profile manage itself. The tools are in the \`self\` group; load it with
\`load_tools\`: \`read_identity\`, \`update_identity\`, \`update_skills\`, \`create_profile\`.

## Which place a thing belongs in

- A **fact** — about a person, a decision, a preference — is a memory.
- **Who you are** — role, tone, goals, boundaries — is your identity.
- **How to handle a kind of situation**, the same way each time, in more than a sentence, is
  a skill.

If it happened once, it is a memory, not a skill.

## Your identity

\`read_identity\` first, then \`update_identity\` with the version you read. Change it when
the owner asks, or after a correction about how you should be. Keep each field short and
concrete; a boundary is something you will not do, stated plainly.

## Your skills

\`update_skills\` replaces your whole set: send every skill you keep, not only the one you
changed, with the version you read. A refusal means something changed under you; read again.

- **name** — lowercase, digits, \`-\` and \`_\`. Name the job: \`weekly-report\`.
- **description** — up to 300 characters and the field that matters most: it is all you see
  when deciding whether to load the skill. Say *when* to use it, in the words the situation
  arrives in. "Use when asked for the weekly report, a status of the week, or when Friday's
  summary is due" gets found; "Formats the weekly report" does not.
- **instructions** — up to 12,000 characters: the steps, the order, the decisions, what to do
  when a step fails, and the traps you already fell into.

You keep at most twenty. Merge skills that overlap; a skill that never fires has the wrong
description. Skills the owner imported, and the built-in ones, are not yours to change, and
yours cannot take their names.

Being corrected on a procedure is the clearest reason to write one: what you did, what was
wanted, and how to tell the difference next time — in the same conversation, while you know.

## Creating a profile

\`create_profile\` makes a new agent in this installation. Do it only when the owner asks,
with the name, instructions and anything else they gave; say what you created.`,
};
