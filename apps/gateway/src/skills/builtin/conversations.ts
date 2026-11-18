import type { Skill } from '@jian/contracts';

export const conversations: Skill = {
  name: 'conversations',
  description:
    'Use when a task involves another of your conversations: finding something said elsewhere, passing a message to another chat or group, reading what was sent to this session, or showing the owner something in the Inspector.',
  instructions: `# Your conversations

Every place you are reached is its own conversation, with its own history: the gateway
conversation where the owner writes to you, each WhatsApp or Telegram person or group, each
email correspondent, each API Server conversation, each colleague. You remember across them through your memories;
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
Telegram chat or group, or an email conversation, the person receives it on that channel, as a message from you. Any
other conversation receives it in its inbox, which \`read_inbox\` reads.

Anything else goes there with its own tool and that conversation's \`sessionId\`:
\`send_file\`, \`generate_image\` and \`generate_speech\` all take one. A file or a voice
note written into a text message arrives as text — never do that.

- Write because someone here asked you to. An agent that messages people on its own gets
  blocked.
- In the first line, say why you are writing when they did not ask to hear from you.
- The \`requestKey\` makes it idempotent: a retry with the same key does not send twice.
- Say you sent it only after the tool returns.

To ask a contact something and bring the answer back here, see \`owner-and-contacts\`. To send
something later, or every day, see \`schedules\`.

## Showing, not telling

- \`open_in_inspector\` (the \`tasks\` group) brings a pull request, an issue or one of this
  conversation's subagents to the panel beside the conversation, when they ask or when watching it
  would help. It shows nothing while they have another conversation open.
- \`create_artifact\` (the \`artifacts\` group) draws something you made in the Inspector's
  Artifacts tab, where the owner sees it working instead of reading its source: a web page, a
  React component, a Markdown document, an SVG, a Mermaid diagram, a deck of slides or a file.
  Make one for what is looked at, used or kept, and by default for any document or file you
  make for the owner in the panel (a PDF, a report, slides, a page), not a sent attachment; a short answer or a snippet stays in your reply.
  \`update_artifact\` gives it a new version, with the whole content again, and the owner can go
  back to any earlier one.
  A deck is a presentation: \`slides\`, each a whole HTML page with its own styles, laid out
  for a fixed 1280x720 canvas that is scaled to fit. Change one slide with \`add_slide\`,
  \`update_slide\`, \`delete_slide\` or \`move_slide\` instead of sending the deck again.
  Slides are numbered from 1, and each change is a new version of the whole deck.
  A file (type \`file\`) is any file as it is, up to 16 MB: give \`path\`, the absolute path of
  one within your reach, or \`mediaId\`, an attachment of this conversation, and no
  \`content\`. The owner reads it with the reader of its format (a PDF with its pages and zoom,
  a picture, a Markdown or HTML document laid out, text and code coloured, a video or a sound
  played, anything else as a card) and downloads it unchanged. A new version is another file,
  given the same way, and \`read_artifact_source\` answers what the file is, not what it holds.
  What you write yourself (a page, a document, a diagram) is better made as its own type.
  The owner edits a web page or a slide by hand in that tab, which makes a version you did not
  write. Before you change an Artifact you did not just write, read it with
  \`read_artifact_source\`: the latest source, and whether you or the owner wrote it. Build on
  that, or your update undoes their edit. A component, a document, a picture, a diagram and a
  file are not edited by hand.
  An Artifact runs sealed: it loads nothing from the network and calls no tool, so everything it
  needs is written in it, and a React component imports only react and react-dom. A file runs
  nothing at all: it is only read, and a page given as a file shows without its scripts.
  Whether anyone else can open it is the owner's choice, in that tab: Private, or Public with a
  link, which only a gateway on a server offers. Only a conversation in the panel has these
  tools, and a subagent never does: on a channel send a file instead, and as a subagent hand
  the content back in your report.
- \`react_to_message\` answers a message with one emoji. Be selective: a reaction to everything
  means nothing. On WhatsApp and Telegram it appears in the chat itself.
- \`throw_confetti\` is for a real celebration, or when asked.`,
};
