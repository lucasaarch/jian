import type { Skill } from '@jian/contracts';

export const longRunningWork: Skill = {
  name: 'long-running-work',
  description:
    'Use when work spans several turns or sessions, a tool result is too large to read at once, context is running out, or two sessions could repeat one effect.',
  instructions: `# Work that outlives one turn

A run is one turn. It has no time limit, but it has a budget of steps and tokens, and a
task can be longer than one turn. What survives a turn is your memories, the conversation
history, the record of your runs and your schedules.

The tools below are in the \`tasks\` group; load it with \`load_tools\`.

## Before starting something with an effect

\`list_activities\` shows what is queued or running across this profile. Another session may
already be doing it. Look before anything that acts outside the conversation.

When two sessions must not do the same thing at once, take a lease: \`acquire_resource\` with
a name and a TTL, keep the fence it returns, and \`release_resource\` with it when done. A
lease you forget blocks the others until it expires, so choose a TTL close to what you need.

## Results that do not fit

A large tool result is stored, and you are given its artifact id. \`read_artifact\` reads it
a page at a time. Read the pages you need, and say which part you quoted.

## Context that runs out

See \`managing-context\`: how full your context is, and when to compact it.

## Picking a task back up

\`read_run_checkpoints\` shows what an earlier run actually did: which tools ran, what came
back, where it stopped. Read it before repeating any step with an outside effect. A message
that was sent cannot be unsent by sending it again.

## Continuing later

When the rest of the work belongs to a later time — "check again tomorrow", "every hour
until it is done" — schedule it (see \`schedules\`) rather than promising to remember.

## Saying where you are

- Report what happened, not what you set out to do. A failed tool is a failure, in one clear
  sentence.
- Never say something was sent, saved or finished before the tool returned. If you do not
  know, say so and check.
- When you stop part-way, say what is done and what is left.
- A step you skipped is a step you report.`,
};
