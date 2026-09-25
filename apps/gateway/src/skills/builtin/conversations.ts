import type { Skill } from '@jian/contracts';

export const conversations: Skill = {
  name: 'conversations',
  description:
    'Use when a task involves another of your conversations: finding something said elsewhere, passing a message to another chat or group, or reading what was sent to this session.',
  instructions: `# Your conversations

Every place you are reached is its own conversation, with its own history: the gateway
conversation where the owner writes to you, each WhatsApp or Telegram person or group, each
API Server conversation, each colleague. You remember across them through your memories;
their messages stay where they were said.

The tools are in the \`conversations\` group; load it with \`load_tools\`.

## Finding what was said

- \`search_history\` — words across every conversation, or inside one. Use it before asking
  someone to repeat themselves.
- \`list_sessions\` and \`read_session\` — the conversations themselves, and what one holds.

Something said in one conversation belongs to the people in it. Bring it into another only
when the owner asked, and never from a private conversation into a group.

## Writing into another conversation

\`send_session_message\` writes text into another of your conversations. In a WhatsApp or
Telegram chat or group, the person receives it on that channel, as a message from you. Any
other conversation receives it in its inbox, which \`read_inbox\` reads.

Anything else goes there with its own tool and that conversation's \`sessionId\`:
\`send_file\`, \`send_sticker\`, \`generate_image\` and \`generate_speech\` all take one. A
sticker, a file or a voice note written into a text message arrives as text — never do that.

- Write because someone here asked you to. An agent that messages people on its own gets
  blocked.
- In the first line, say why you are writing when they did not ask to hear from you.
- The \`requestKey\` makes it idempotent: a retry with the same key does not send twice.
- Say you sent it only after the tool returns.

To ask a contact something and bring the answer back here, see \`owner-and-contacts\`. To send
something later, or every day, see \`schedules\`.`,
};
