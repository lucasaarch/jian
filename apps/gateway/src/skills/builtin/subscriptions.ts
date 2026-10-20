import type { Skill } from '@jian/contracts';

export const subscriptions: Skill = {
  name: 'subscriptions',
  description:
    'Use when asked to watch GitHub CI, wait for a check to finish, or continue when a pull request merges or closes — Listening without pausing for webhook setup.',
  instructions: `# Listening for GitHub events

A subscription is an instruction, a conversation, and a GitHub filter. The gateway **polls**
GitHub on an interval (default every 30 seconds) and wakes this conversation **only when the
watched state changes** (CI conclusion, PR merged/closed) — not on every poll tick. Unchanged
polls stay silent. Do **not** message the channel that the watcher is "still active" or that
CI is "still pending" while nothing changed — the gateway already handles that quietly.
Listeners **expire** (default 1 hour; set \`durationSeconds\` for 30 minutes, 1 hour, or 1 day).
Keep or open a session objective so a real wake continues the work. Do **not** pause the
objective for webhook configuration — polling is enough.

The tools are in the \`subscriptions\` group; load it with \`load_tools\`:
\`list_subscriptions\`, \`create_subscription\`, \`update_subscription\`, \`delete_subscription\`.

## Writing one

- **name** — short, for the owner's list: "PR 38 Check", "Wait for merge".
- **instruction** — the request you will receive when the event fires, written for a version
  of you that remembers nothing of this conversation. Say what to do next (read the check
  conclusion, fix failures, continue the objective). Do not ask yourself to report "still
  waiting" on every poll.
- **owner** / **repo** — GitHub repository.
- **pullNumber** — the pull request to watch. Required for polling CI or merge state.
- **events** — one or both of \`check_suite.completed\` (CI finished) and
  \`pull_request.closed\` (merged or closed).
- **checkName** — optional; only that check run name counts (e.g. "Check").
- **pollIntervalSeconds** — optional; default 30, at least 15.
- **durationSeconds** — optional; how long to keep watching from now. Default 3600 (1 hour).
  Use 1800 for thirty minutes, 86400 for one day. Extend with \`update_subscription\` if the
  wait needs more time. There is no infinite watch by default.
- **sessionId** — omit it to wake this conversation.

After creating one, tell the person you are watching and will continue when it finishes —
once. Do not keep confirming the watcher on unchanged polls. Do not ask them to configure a
repository webhook. A webhook secret may be returned for an optional faster path; ignore it
unless they want that setup.

## Private repositories

Polling uses the profile's \`gh\` login when present (\`gh auth login\` in the workspace).
Public repositories work without it.

## When a wake arrives

Nobody typed it just now: the watched event fired. Carry out the instruction and continue
any open session objective. Do not explain the Listening mechanism unless it helps them.
Do not re-check GitHub in a loop to send "still pending" updates — wait for the next wake.`,
};
