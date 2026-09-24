import type { Skill } from '@jian/contracts';

export const memoryKeeping: Skill = {
  name: 'memory-keeping',
  description:
    'Use before remember: what is worth storing, how to name a key, and how to keep the notebook tidy with links and deletions.',
  instructions: `# Memory keeping

Your memory is a small shared notebook. Every session of this profile reads the same
entries. Only the entries whose words match the current message are put in front of you,
and with each of them the entries linked to it. Write for the version of you that will read
one entry months from now with no other context.

## What earns an entry

Write it down when it is durable and it changes what you do later:

- who the person is: how they want to be addressed, the language they write in, the work
  they do, who else appears in their life by name;
- decisions and their reason — the reason is the part you will not be able to reconstruct;
- standing preferences: how they want answers shaped, what they never want suggested again;
- commitments with a date, and what the date is for;
- anything you were corrected on. A correction you forget, you repeat.

## What does not

- the current message, or anything you can re-read with \`search_history\`;
- what you inferred but were not told;
- secrets, passwords, card numbers, one-time codes — they belong in nothing you store;
- anything a contact who is not the owner told you about themselves, unless the owner asked
  you to keep it;
- your own plans for the next few minutes.

## How to write one

\`remember\` takes a key, the content and the version you expect.

- The key is lowercase letters, digits, \`-\` and \`_\`, up to 100 characters. Name it by
  subject, not by date: \`billing-preferences\`, not \`note-2026-03\`. A good key is the one
  you would guess if you were looking for that fact.
- Search first: \`read_memories\` with a few words of the subject. If an entry already covers
  it, update that one. A near-duplicate under a new key splits what you know in two, and
  only one half gets recalled.
- \`expectedVersion: 0\` creates a key. Any other number updates the entry at exactly that
  version, the one \`read_memories\` showed you; a stale version is refused, and that refusal
  is protecting a write from another session.
- Content is up to 4000 characters. Write plain sentences, and put the fact before the
  story. Say when it was true: "since March 2026 they bill quarterly" ages better than
  "they bill quarterly".
- One subject per key. When a fact stops being true, rewrite that key instead of adding a
  second one — two entries that disagree are worse than none.

## Links

Two entries about one subject, or that only make sense together, can be linked with
\`link_memories\`: when one is recalled, the other comes with it, even if the message never
mentions it. A recalled entry marked \`recalledWith\` came through such a link. Link a
person to the project they run, a decision to the constraint behind it. Do not link
everything to everything: a link that is not needed spends room that a relevant entry would
have used. Recall follows one link, never a chain.

## Tidying

\`forget_memory\` deletes an entry and its links, for good. Use it when an entry is wrong, no
longer true, or merged into another: when two entries say the same thing, rewrite one with
everything worth keeping, then forget the other. The owner can edit and delete entries too,
from the panel; an entry they rewrote carries their version.

## Saying it happened

\`remember\` can fail. Say a fact was saved only after its call returns. If it was refused,
read the current version, merge what you meant to add, and try once more.`,
};
