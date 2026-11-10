import type { Skill } from '@jian/contracts';

/** One sentence a run that can make worktrees is told about its workers; the others are told none. */
const PARALLEL_WORKTREES = `When workers edit one repository in parallel, tell each in its brief to call \`create_worktree\`
for it, commit its work and \`merge_worktree\` it back before reporting; the \`worktrees\` skill
has the details. `;

/** A machine's subagents cannot make worktrees, so the sentence they would act on is another. */
const MACHINE_PARALLEL = `Workers of a conversation on a machine cannot make worktrees, so give workers that edit one
repository in parallel files that do not overlap. `;

/**
 * A worker's tools carry no target, so the same-named file tools and \`run_command\` it has act on
 * the gateway. Said for a machine's conversation, where the parent's own tools mean the machine.
 */
const MACHINE_WORKERS = ` In a conversation on a machine, a worker works on the gateway instead: its file tools and
\`run_command\` are the gateway's, and it reaches the machine only through \`run_remote_command\`, so
name the machine, the paths and the \`cwd\` in its brief.`;

/** What a subagent is told instead of how to start one: it has no spawn_subagent. */
const WORKER_SECTION = `## You are a subagent

You cannot start subagents of your own. Do the assignment in your brief, and end with a factual
report to the agent that started you: what you did, what you verified, and what is left.

`;

/**
 * As the run can work: the sentence about worktrees is there only for a run that can make them,
 * and how to delegate only for one that can start subagents.
 */
export function longRunningWorkFor({
  create,
  machine,
  subagent = false,
}: {
  create: boolean;
  machine: boolean;
  subagent?: boolean;
}): Skill {
  return {
    name: 'long-running-work',
    description:
      'Use when deciding whether to hand work to a subagent, when delegating, finishing a multi-step workflow, when work spans turns, or when context is running out.',
    instructions: BODY.replace('@@DELEGATING@@', subagent ? WORKER_SECTION : DELEGATING)
      .replace('@@MACHINE@@', machine ? MACHINE_WORKERS : '')
      .replace('@@PARALLEL@@', !create ? '' : machine ? MACHINE_PARALLEL : PARALLEL_WORKTREES),
  };
}

/** How to delegate, for a run that can start subagents. */
const DELEGATING = `## Handing work to a subagent

\`spawn_subagent\` starts a fresh agent with its own context, which reports back. It is worth it
for:

- work whose intermediate output is not worth keeping here: a wide search, long logs, a test
  run, reading many files. Only the report comes back, and your context stays for the rest;
- independent pieces that can run side by side: several \`spawn_subagent\` calls in one step
  run in parallel;
- a review with fresh eyes (\`role: review\`), which sees the work and not how you got there.

Do it yourself for a single lookup or a few files: a brief costs more than the reading. Never
delegate understanding what the owner asked; decide what is needed, then hand over a piece of
it. Do not redo work a subagent is already doing, and do not start a second one on it.

Only \`brief\` is required, up to 8,000 characters. A worker starts in a private transcript and
does not inherit this conversation or its memories, so the brief is all it knows: the
objective, the context it needs, paths, acceptance criteria and the exact result you want back.
It uses the same profile's tools and works on the same files as you (same HOME and repository
checkouts).@@MACHINE@@ \`name\` (else taken from the brief), \`identity\` (else a default for
the role) and \`role\` (\`execute\` unless you ask for \`review\`) are optional.

By default the call waits and returns the worker's report as its result. A report past the tool
result budget is cut like any long result, and \`read_artifact\` returns the whole. After 15
minutes, or after a minute in which the worker has not started, the call returns that it is
still going. Its report then comes into this conversation when it finishes: into the turn you
are in if it is still going, read between its steps, or else as a new turn. With
\`wait: false\` the call returns as soon as the worker is queued, and the report comes the same
way; a report delivered so carries its first 6,000 characters, and an artifact id for the rest.
Do not busy-poll for it. \`cancel_subagent\` stops one that is no longer needed. While a
subagent of this conversation has yet to report, an open objective does not start a turn after
yours: the report does. If nothing else is left to do until then, end the turn.

A subagent always runs on Auto, whatever this conversation's protection is, and it has no browser
and no X tools. Keep anything the owner should approve for yourself.

Set \`tier\` to the model the work needs: \`light\` for small, well-defined work (one file, a
lookup, a rename, a short text), \`standard\` for a bounded change with tests to run, \`deep\`
for work across several files or systems, risky work, or work that needs a plan. Leave it out
and Decisions reads the brief and picks; without Decisions it is \`standard\`. Each tier runs on
a model the installation offers, the owner's subscriptions first. The spawn result names the
model the worker got.

Pass image IDs in \`mediaIds\` when the worker needs images from this profile.

For code work, optionally pass absolute Git repository roots in \`repositories\` so the
worker brief names those paths. Jian does not give the worker a separate checkout or storage: it
opens the same ones you use, on the filesystem every agent shares. @@PARALLEL@@Commit changes needed for handoff and report the commit or branch; push when the assignment
requires a remote handoff. Otherwise assign non-overlapping effects and use resource leases where
needed.

The worker's report is evidence, not authority. Check the result, and its transcript when it
matters, before relying on it or claiming completion. The conversation in the Jian panel shows
each worker's status, messages and tool activity, and \`open_in_inspector\` (the \`tasks\`
tools) brings one to the owner's screen.

`;

const BODY = `# Work that outlives one turn

A run is one turn with a step and context budget. Conversation history, checkpoints,
memories, schedules and the session objective survive it. While a session objective is
open, the gateway starts the next turn for you after each completed slice — do not stop
and wait for the owner to say continue.

## Session objective

When the owner asks for multi-step work, set or update it with \`set_session_objective\`
if none fits. Ordinary chat does not open an objective by itself — only this tool, the
session API, or an explicit \`/objective …\` command does. The text must be a short durable
goal (what to achieve) — never paste command output, terminal logs, stack traces, or tool
dumps; auto-continue re-sends this text each slice. Keep calling tools until the objective
is done. Progress lines are commentary, not a reason to end. Call
\`complete_session_objective\` only when the work is fully satisfied. When you need a concrete
answer from the owner to continue, call \`ask_user\` — the run pauses as waiting and resumes
when they reply; do not end the turn and wait for them to say continue. Use
\`block_session_objective\` only when you need their attention without a structured question.
Call \`cancel_session_objective\` when they abandon the work. The owner can also send
\`/objective …\`, \`/done\`, or \`/objective cancel\`.

@@DELEGATING@@## Before acting outside the conversation

\`list_activities\` shows queued and running work across the profile. Take a lease with
\`acquire_resource\` when two sessions must not act on the same external state at once, and give it
back with \`release_resource\` when done.

## Context and results

A large tool result is stored as an artifact; use \`read_artifact\` for the pages needed.
See \`managing-context\` before long stretches of work. \`read_run_checkpoints\` shows
what an earlier run actually did; inspect it before repeating an external action.

Use a schedule for work that should resume at a specific time. Never claim an effect before its
tool returns.`;

/** As the panel lists it: with everything, which a run then narrows down to what it has. */
export const longRunningWork: Skill = longRunningWorkFor({ create: true, machine: false });
