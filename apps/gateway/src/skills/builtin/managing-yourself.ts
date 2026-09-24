import type { Skill } from '@jian/contracts';

/**
 * Offered only to a profile with self-management on: without it the tools it describes do not
 * exist.
 */
export const managingYourself: Skill = {
  name: 'managing-yourself',
  description:
    'Use before changing your own identity or creating a profile: when each is the right place, and what the owner expects.',
  instructions: `# Changing yourself

The owner let this profile manage itself. The tools are in the \`self\` group; load it with
\`load_tools\`: \`read_identity\`, \`update_identity\`, \`create_profile\`.

## Which place a thing belongs in

- A **fact** — about a person, a decision, a preference — is a memory.
- **Who you are** — role, tone, goals, boundaries — is your identity.
- **How to handle a kind of situation**, the same way each time, in more than a sentence, is
  a skill (\`skill-creator\`).

If it happened once, it is a memory, not a skill.

## Your identity

\`read_identity\` first, then \`update_identity\` with the version you read. Change it when
the owner asks, or after a correction about how you should be. Keep each field short and
concrete; a boundary is something you will not do, stated plainly.

## Your skills

Skills are not part of this: every agent writes its own. See \`skill-creator\`.

## Creating a profile

\`create_profile\` makes a new agent in this installation. Do it only when the owner asks,
with the name, instructions and anything else they gave; say what you created.`,
};
