import type { Skill } from '@jian/contracts';

export const conversations: Skill = {
  name: 'conversations',
  description:
    'Use when a task involves another of your conversations: finding something said elsewhere, passing a message to another chat or group, reading what was sent to this session, showing the owner something in the Inspector, or sharing an Artifact or sending it as a file.',
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
  React component, a Markdown document, a spreadsheet, a Mermaid diagram
  or a deck, which is a set of slides. Make one for what the owner looks at, uses or changes and keeps working
  on (a page, slides, a document, a table of numbers, a diagram); a short
  answer or a snippet stays in your reply. A finished file (a
  PDF, a Word or Excel file, a picture) is not an Artifact: send it with \`send_file\`.
  To change one, use \`edit_artifact\`, as you edit a file: each \`find\` is text copied exactly
  from its current source and is replaced by its \`replace\`, in order, so only what you name
  changes. A \`find\` that matches nothing or more than one place refuses the whole call and
  says which edit; copy more of the text around it and try again. \`update_artifact\` writes
  the whole content again: only to rewrite most of it. Each change is a new version, and the
  owner can go back to any earlier one.
  A deck is a set of slides: \`slides\`, each a whole HTML page with its own styles, laid out
  for a fixed 1280x720 canvas that is scaled to fit. Edit part of a slide with
  \`edit_artifact\` and its \`slide\`; change a whole slide with \`add_slide\`,
  \`update_slide\`, \`delete_slide\` or \`move_slide\` instead of sending the deck again.
  Slides are numbered from 1, and each change is a new version of the whole deck.
  A spreadsheet is CSV, where a cell starting with \`=\` is a formula the sheet works out
  (\`=SUM(B2:B9)\`); downloaded, it is an Excel file with the formulas kept, or a CSV of
  the values. A document downloads as Word, PDF or Markdown.
  The owner watches what you write as you write it: the tab opens on the Artifact while its
  tool call is still being written, and shows it grow. Nothing is kept until the call ends,
  and a call that fails leaves no version.
  The owner edits a web page, a slide, a document and a spreadsheet by hand in
  that tab, and what they change is kept by itself as they pause or leave, with no Save: one
  stretch of editing is one version of theirs, never written over one of yours. Before you
  change an Artifact you did not
  just write, read it with \`read_artifact_source\`: the latest source, and whether you or the
  owner wrote it. Build on that, or your update undoes their edit. A component and a
  diagram are not edited by hand: they change when you edit or write them again. A component stands on
  a canvas with Tweaks beside it, where the owner tries the props it exports as \`tweaks\` and
  its theme; nothing set there is saved or reaches you.
  An Artifact runs sealed: it loads nothing from the network and calls no tool, so everything it
  needs is written in it, and a React component imports only react and react-dom.
  Whether anyone else can open it is the owner's choice: Private, or Public with a link, which
  only a gateway on a server offers. They set it in that tab, or ask you, and then
  \`share_artifact\` makes it public and answers the link to give them, or makes it private
  again, which stops the link working. Never share one they did not ask you to. Each time it is
  made public the link is new, and an earlier one never works again. When the gateway does not
  know its own address, you get only the path: say so, and that setting \`JIAN_PUBLIC_URL\`
  gives the whole link.
  When they want the file, to keep, forward or open away from the panel, \`send_artifact\`
  sends it in the format they ask for, among those its type has, which its \`format\` lists:
  a document as Markdown, Word or PDF, a deck as PDF, PowerPoint or one slide as a picture, a
  spreadsheet as Excel or CSV, the rest as their source. When they ask for one its type lacks,
  say which it has. With
  \`sessionId\` it goes to another of your conversations instead, so a WhatsApp, Telegram or
  email conversation with the owner receives it there. A PDF, a PowerPoint file and a picture
  are drawn by the gateway's browser, which the desktop app's own gateway does not have. Say it
  was sent only after the tool returns.
  The owner also sees every Artifact of yours, from any conversation, under Artifacts at the
  top of the sidebar, where they pin, rename and duplicate them and keep them in folders, none
  of which you can do for them, and can delete one for good; make it again if they ask for one
  that is gone. A phone paired by QR code does all
  of that too, but edits none by hand and makes none public. A name they gave one there is the
  title you read back. Only a conversation in the panel has these tools, and a subagent never
  does: on a channel send a file instead, and as a subagent hand the content back in your
  report.
- \`react_to_message\` answers a message with one emoji. Be selective: a reaction to everything
  means nothing. On WhatsApp and Telegram it appears in the chat itself.
- \`throw_confetti\` is for a real celebration, or when asked.`,
};
