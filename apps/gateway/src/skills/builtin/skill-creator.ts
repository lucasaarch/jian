import type { Skill } from '@jian/contracts';

export const skillCreator: Skill = {
  name: 'skill-creator',
  description:
    'Use when you notice you handle a kind of situation the same way again, when the owner corrects how you did something, or when asked to write, change or remove a skill of yours.',
  instructions: `# Writing your own skills

A skill is how you handle one kind of situation, written down so you do it the same way
every time. The tools are in the \`skills\` group; load it with \`load_tools\`:
\`create_skill\`, \`update_skill\`, \`delete_skill\`.

## Skill or memory

- A **fact** — about a person, a decision, a preference — is a memory.
- A **way of doing something** that repeats — steps, an order, a format, checks — is a skill.

"Lucas likes the weekly summary on Mondays" is a memory. "How to write the weekly summary:
what to gather, in what order, what to leave out" is a skill. If you find memories that are
really a procedure, turn them into one skill and delete the memories.

## When to write one

- The owner corrected how you did something: write what was wanted and how to tell next time,
  in the same conversation, while you know.
- You did the same multi-step job twice, or the owner asked for it "always like this".
- The owner asked you to.

Once is not a routine. A one-line rule belongs in a memory or in your identity.

## How to write it

- **name** — lowercase, digits, \`-\` and \`_\`. Name the job: \`weekly-report\`,
  \`invoice-follow-up\`.
- **description** — up to 300 characters, and the field that matters most: it is all you see
  when deciding whether to open the skill. Say *when* to use it, in the words the situation
  arrives in. "Use when asked for the weekly report, a summary of the week, or on Friday
  afternoon" gets used; "Formats the weekly report" does not.
- **instructions** — up to 12,000 characters, in Markdown: the steps in order, the decisions
  and how to make them, what to do when a step fails, and the traps you already fell into.
  Write for yourself on a busy day: short, concrete, with the exact names and values.

## Looking back on your own

When the owner leaves learning on, the gateway also asks you to look back after a turn with
many tools, after one where a tool failed and you recovered, and every fifteen turns. That
review happens in your Learning conversation, with only the memory and skill tools. Most of
the time the right answer there is "Nothing to keep."

## Keeping them good

- \`update_skill\` when a skill was wrong or incomplete — a correction is the best reason.
- One skill per job. Merge two that overlap and \`delete_skill\` the other.
- A skill that never gets opened has the wrong description; rewrite that first.
- You can change only the skills you wrote. The owner's and the imported ones, and the
  built-in ones, are theirs; if one is wrong, tell the owner what to change.
- A profile holds twenty skills in all.

Tell the owner in a line when you write or change a skill, and what it is for. It appears
under **Skills** in the panel, marked as written by you, where they can read it, switch it
off or remove it.`,
};
