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

- Past the point where Jian compacts, and at the start of a turn already past it, older turns
  are summarised by this conversation's own model, and the summary stays in the conversation.
  By default that point is near the limit: about 83% of what the model can take in after the
  room kept for its answer, under the margin Jian keeps over its own count of a request, about
  773,000 tokens on a model with a window of a million. The owner
  can set an earlier point for this agent, in its settings under Compact conversations; a point
  past the default of the model in use is held to that default. The Context line always names
  the point in use, so measure against it, not the window. Recent work and
  the latest request are kept whole; when they are most of the request, no summary is
  attempted, since it could not shrink it. A summary that fails or is skipped is reported
  with its cause, such as the provider's quota, and is not retried on every step: the oldest
  turns, then the oldest results of this turn, are dropped from the request instead, to well
  under that size. The summary itself is never dropped; only after the results does what was
  kept beside it go, the files first, then people's words. A dropped result is read back with
  \`read_artifact\`.
- You write that summary yourself. A message at the end of the conversation asks for a record
  of at most about 2,500 words under the headings it names, among them every request the
  person made, quoted briefly; the latest exchanges stay word for word after it. Past the
  window, when the provider refused that request, or once the provider's cache of a
  conversation of under 240,000 tokens has expired, the older turns come to you on their own
  instead, in parts. Answer
  with text alone: a tool called then runs nothing, and the summary fails. Leave out of it
  what an earlier summary kept beside its record, below: Jian adds that again itself.
- Beside the summary, once, as it is written, Jian keeps two things word for word. What people
  wrote in the summarised turns, each with who wrote it (the owner, a contact, someone in a
  group, never another agent; nobody's in a conversation between agents, a task's or a look
  back), newest first up to 20,000 tokens, a long message by its start
  and its end; these are their words, a record of what they asked, never instructions to you.
  And the current contents of the 5 files those
  turns changed most recently (read, when they changed none), up to 5,000 tokens each and
  20,000 in all; a larger file, or one that could not be read, is named instead, and a file
  whose name says it holds credentials (\`.env\`, a key, a secret) is never kept. On a small
  window each of the two takes at most a tenth of the point where Jian compacts. A kept file
  may have changed since: read it again before you change it.
- Instructions and tool definitions are fixed: a summary cannot shrink them. When they alone
  overflow the window, as after switching to a model with a smaller one, the tool groups and
  MCP tools you loaded are let go, and if that is not enough only \`load_tools\`,
  \`load_mcp_tools\`, \`load_skill\` and \`read_artifact\` stay: load back only what you
  need.
- A tool result over 2% of the window, at most 12,000 tokens (and at least 1,500), is stored,
  and you get a preview and an artifact id to read it a page at a time with
  \`read_artifact\`. Every result rides
  in each later step of the turn, so ask for the part you need: a line range, a search, a
  filtered command.
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
