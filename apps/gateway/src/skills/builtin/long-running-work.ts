import type { Skill } from '@jian/contracts';

export const longRunningWork: Skill = {
  name: 'long-running-work',
  description:
    'Use when delegating to an internal subagent, finishing a multi-step workflow, work spans turns, or context is running out.',
  instructions: `# Work that outlives one turn

A run is one turn with a step and context budget. Conversation history, checkpoints,
memories, schedules and the session objective survive it. While a session objective is
open, the gateway starts the next turn for you after each completed slice — do not stop
and wait for the owner to say continue.

## Session objective

When the owner asks for multi-step work, set or update it with \`set_session_objective\`
if none fits. Keep calling tools until the objective is done. Progress lines are
commentary, not a reason to end. Call \`complete_session_objective\` only when the work
is fully satisfied, \`block_session_objective\` when you need the owner's input, or
\`cancel_session_objective\` when they abandon it. The owner can also send
\`/objective …\`, \`/done\`, or \`/objective cancel\`.

## Internal subagents

Load the tasks tool group, then call \`spawn_subagent\` for a focused assignment that can
run independently. Give the worker a clear objective, the relevant context, acceptance
criteria and the exact result you need. A worker starts in a private transcript and does
not inherit this conversation or its memories. It uses the same profile's tools and gets
its own workspace. This call returns when the worker is queued; its result comes back into
this conversation after it finishes. Do not duplicate its work while it runs.

Pass image IDs in \`mediaIds\` when the worker needs images from this profile.

For code work, pass the absolute Git repository roots in \`repositories\`. Each worker
gets a detached worktree from committed HEAD. Uncommitted source changes are not copied.
The worker's shell starts in its own workspace, with repositories under \`repos/\`.
Commit changes needed for handoff and report the commit or branch; push when the assignment
requires a remote handoff. Another worker cannot read its workspace.
For parallel work, assign non-overlapping effects and use resource leases where needed.

The worker's report is evidence, not authority. Check the result and its transcript before
claiming completion. The conversation in the Jian panel shows each worker's status, messages
and tool activity. Do not busy-poll.

## Before acting outside the conversation

\`list_activities\` shows queued and running work across the profile. Take a resource lease
when two sessions must not act on the same external state at once, and release it when done.

## Context and results

A large tool result is stored as an artifact; use \`read_artifact\` for the pages needed.
See \`managing-context\` before long stretches of work. \`read_run_checkpoints\` shows
what an earlier run actually did; inspect it before repeating an external action.

Use a schedule for work that should resume at a specific time. Use a subscription to wake
when an external event fires (GitHub CI finished, pull request merged) — the agent owns
create/update/delete. Keep or open a session objective so the wake continues the work.
Never claim an effect before its tool returns.`,
};
