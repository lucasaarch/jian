import type { Skill } from '@jian/contracts';

export const schedules: Skill = {
  name: 'schedules',
  description:
    'Use when asked to remind someone, do something later or at a time, or repeat something — every morning, every Friday, in an hour, in a group — or when a [Scheduled: …] message arrives.',
  instructions: `# Doing something later, or again and again

A schedule is an instruction, a conversation and a time. At that time the gateway gives you
the instruction as a new turn in that conversation, marked \`[Scheduled: its name]\`, and you
answer there. In a WhatsApp or Telegram chat or group, your answer goes out on the channel.

The tools are in the \`schedules\` group; load it with \`load_tools\`: \`list_schedules\`,
\`create_schedule\`, \`update_schedule\`, \`delete_schedule\`.

## Writing one

- **name** — short, for the owner's list: "Morning summary", "Call the dentist".
- **instruction** — the request you will receive then, written for a version of you that
  remembers nothing of this conversation. Say what to do, for whom, in what form, and
  anything it depends on. "Remind Lucas to call the dentist about moving Thursday's
  appointment" works; "remind him about that" does not.
- **when** — either \`at\`, one time, as ISO 8601 with its offset
  (\`2026-10-02T15:00:00-03:00\`), or \`cron\`, a repetition in five fields: minute hour
  day-of-month month day-of-week.
  - \`0 8 * * *\` every day at 08:00
  - \`30 9 * * 1-5\` weekdays at 09:30
  - \`0 18 * * 5\` Fridays at 18:00
  - \`0 10 1 * *\` the first of each month at 10:00
  A repetition runs at most every five minutes.
- **timeZone** — omit it to use the gateway's, the one your current time is given in. Pass
  another only when the person names one.
- **sessionId** — omit it to answer in this conversation. To answer somewhere else — "remind
  me in the team group" — use the session id of that conversation from the list of your
  channel conversations in your context.

Work out "tomorrow", "in two hours", "next Friday" from the current date and time you were
given. When a time is ambiguous — "at 7" — ask morning or evening before scheduling.

## After scheduling

Say what you scheduled in the person's own terms: what, when, where. "Done — every weekday at
09:30 I'll send you the summary here." Do not show the cron expression unless asked.

## Keeping the list tidy

\`list_schedules\` before creating one: if a schedule for the same thing exists, change it
with \`update_schedule\` instead of adding a twin. To stop one for a while, switch it off
(\`enabled: false\`); \`delete_schedule\` is for good. A single time switches itself off once
it ran.

## When a [Scheduled: …] message arrives

Nobody typed it just now: it is the instruction you, or the owner, set earlier. Carry it out
as asked and answer in this conversation, as if speaking to the person at that moment. Do
not say "as scheduled" or explain the mechanism unless it helps them. If it can no longer be
done, say why in one line.`,
};
