import type { Skill } from '@jian/contracts';

export const managingContext: Skill = {
  name: 'managing-context',
  description:
    'Use before a long stretch of work when the Context line says the turn starts more than halfway to where Jian summarises, when a conversation changes subject, or when you lose track of what was said earlier.',
  instructions: `# Your context

Your context is everything sent to the model on each step: your instructions, the
conversation so far, the turn context, and every tool result of this turn. It has a budget.
The turn context, just before each request, holds the time, the memories that may help, what
else is running, and a last line on how far the request is from the point where Jian
summarises it: "Context: this turn starts at about 41,000 tokens, 21% of the way to 200,000,
where Jian summarises the older turns." Each tool result adds to it until the turn ends.
Every size here is in the model's own tokens.

## What the gateway does on its own

- Past 80% of the budget or 200,000 tokens, whichever comes first, and at the start of a turn
  already past it, older turns are summarised by this conversation's own model, and the
  summary stays in the conversation. On a model with a window of a million tokens that point
  is a fifth of it, so the Context line measures against it, not the window. Recent work and
  the latest request are kept whole; when they are most of the request, no summary is
  attempted, since it could not shrink it. A summary that fails or is skipped is reported
  with its cause, such as the provider's quota, and is not retried on every step: the oldest
  turns, then the oldest results of this turn, are dropped from the request instead, to well
  under that size. A dropped result is read back with \`read_artifact\`.
- You write that summary yourself. A message at the end of the conversation asks for a record
  of at most about 2,500 words under the headings it names, among them every request the
  person made, quoted briefly; the latest exchanges stay word for word after it. Past the
  window, once the provider's cache of the conversation has expired, or when the provider
  refused that request, the older turns come to you on their own instead, in parts. Answer
  with text alone: a tool called then runs nothing, and the summary fails.
- Instructions and tool definitions are fixed: a summary cannot shrink them. When they alone
  overflow the window, as after switching to a model with a smaller one, the tool groups and
  MCP tools you loaded are let go, and if that is not enough only \`load_tools\`,
  \`load_mcp_tools\`, \`load_skill\` and \`read_artifact\` stay: load back only what you
  need.
- A tool result over 2% of the window, at most 12,000 tokens (and at least 1,500), is stored
  whole and cut, with its artifact id. Text (a command's output, a file, a search, a page)
  keeps its first and last parts, under a line giving its full size in lines and tokens, with a
  marker saying how much of the middle was left out; anything else keeps the start of its JSON.
  One step's results together get three times that room: past it, the largest are cut first.
  \`read_artifact\` with the artifact id returns the whole, a page at a time. Every result rides
  in each later step of the turn, so ask for the part you need: a line range, a search, a
  filtered command.
- When you have \`spawn_subagent\`, work whose output you need only the outcome of (a wide
  search, long logs, a test run) can go to a subagent: only its report comes back here.
- A skill you load is dropped, least recently used first, once loaded skills pass a tenth of
  the window, at most 16,000 tokens.
- The tool results of your two latest turns stay whole in the conversation. Older ones are cut
  to their input and the head of their result, marked \`cut\`: \`read_artifact\` with the
  call's id as \`toolCallId\` returns the whole result. Read it back rather than repeating a
  call, above all one that changed something.
- A skill you load stays in your instructions, under Loaded skills, for the rest of the
  conversation, and the catalog marks it loaded: never load it again. Tool groups and MCP tools
  you load stay loaded too. At a compaction, what you did not use since the one before is let go,
  and loaded again if you need it.

If even the current request and fixed instructions cannot fit after that, the gateway reports
an explicit context error, naming what the tools and instructions cost. What you lose to a
successful summary is detail; the original messages remain searchable.

## When to compact yourself

\`compact_context\` (the \`tasks\` group; load it with \`load_tools\`) asks for the summary
now, before the next step. Use it:

- before starting a big new task or a long stretch of tool work, when the Context line says
  the turn starts more than about halfway to where Jian summarises: the summary then comes
  before the work, not in the middle of it;
- when the conversation moved on to a new subject and the old one is only weight;
- after a large result you have finished with, before reading the next.

Do not compact in the middle of something you still need word for word: a quote, a diff you
are applying, a list you are working through.

## Before a summary takes the detail

Keep outside the conversation what must survive it:

- a fact, a decision or a preference: a memory (\`remember\`);
- a procedure you worked out: a skill (see \`skill-creator\`);
- where you are in a long task: say it in your answer, or schedule the rest (see
  \`schedules\`).

## When you lose track

If the conversation refers to something you no longer see, it was summarised. Check the
summary at the top of the conversation, then \`search_history\` (the \`conversations\`
group) for the exact words, before asking the person to repeat themselves.`,
};
