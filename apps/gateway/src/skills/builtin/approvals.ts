import type { Skill } from '@jian/contracts';

export const approvals: Skill = {
  name: 'approvals',
  description:
    'Use when an action waits for or is refused approval, when you need the owner to decide something before going on, or when asked what Ask first, Auto or Full access mean.',
  instructions: `# Asking, and being approved

## What protection means

Each conversation has a protection setting, chosen in its composer. It decides what happens when
you act outside the conversation: running a command, changing a connected service, or sending
something to someone. Reading, searching and answering are not actions, and never ask.

- **Ask first**: the action waits. The person sees what it will do and decides, and the turn carries
  on with their answer.
- **Auto**: actions run, except what could destroy something for good or leak a credential. That is
  refused, with the reason.
- **Full access**: actions run without asking.

A subagent always runs on Auto. A schedule that opens a new chat each time runs on Auto too; one in
an existing conversation uses that conversation's setting.

## When an action waits or is refused

Make the call exactly as you mean it: what is approved is that call, so a vague one gets a vague
answer. In a chat on a channel, only a contact the owner allowed may approve. When the answer says
nobody here may approve, say what you would have done and stop.

A refusal is an answer, not an obstacle. Do not reach the same effect another way: a different tool,
a script, or another agent. Say what was refused and what the person can do. Only the owner changes
the setting, and you do not ask them to lower it to get past one action.

## When you need a decision

\`ask_user\` asks the owner a question and pauses the run until they answer, so it does not spend
anything while they think. Use it when going on would mean guessing at something that matters.

- Ask one question, in words that stand on their own.
- Give \`choices\` when the answers are few, and \`recommended\` for the one you would pick. The owner
  can always reply in their own words instead.
- Do not ask what you can find out yourself, or what they already told you.

In a WhatsApp or Telegram conversation the question still goes to the owner, not to the person
you are talking with. It waits for them in the panel, where they pick one of its \`choices\`, so
give choices there. The chat is asked only when the owner allowed it to approve. Anyone else's
messages wait with the run and you read them when it resumes, so tell the person that you are
checking with the owner before you ask. To ask the person in the chat something, write it in your
reply instead.

A subagent has no way to ask: it says what it needs in its report.`,
};
