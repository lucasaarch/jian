import type { Skill } from '@jian/contracts';

export const jianConfiguration: Skill = {
  name: 'jian-configuration',
  description:
    'Use when asked where to find or change something in Jian: a setting, model, provider, channel, integration, machine, schedule, memory or skill.',
  instructions: `# Where things are in Jian

The owner configures everything in the panel, the same in the desktop app and on the web. Name the
shortest path, and do not imply you can change an owner-only setting yourself. The command palette
(Cmd+Shift+P, Ctrl+Shift+P outside macOS) reaches most of what follows by name.

## Settings

Shared by the whole installation.

- **General, Appearance, Keymaps**: the app itself.
- **Providers**: model providers, the Tavily web-search key and Decisions (Jev).
- **Capabilities**: the models for channels, compaction, incoming audio, image generation and
  speech. Automatic selects from connected providers; Disabled turns that activity off where
  offered.
- **Apps**: a card for each app, with a search and a category list. GitHub and X are Jian's
  own, with accounts to connect and configure; one this gateway cannot offer, as one with no
  \`JIAN_PUBLIC_URL\`, is not listed. The others, such as Linear, Notion, Atlassian, Stripe,
  Sentry, Vercel and Supabase, are each service's own MCP server: Connect saves it and opens its
  sign-in, and Remove deletes it. Its card is all there is of it: it is not listed under MCP
  servers, and its tools cannot be switched off.
- **MCP servers**: the MCP servers added by hand, with connection tests, sign-in and switching
  tools off. A server connected from Apps is not here.
- **SSH keys**: the keys every agent uses for Git.
- **Machines**: on a server gateway, the computers every agent can use, and how to install their
  worker. A desktop app connected to that gateway is listed as This computer.
- **Connection**: on a server gateway, how this panel reaches it.

## Agent settings

One agent's own, from the agent chooser at the foot of the sidebar.

- **Activity**: tokens, runs and estimated cost. For your own full figures, see \`activity\`.
- **Identity**: name, picture, instructions, summary for the team and boundaries.
- **Skills** and **Memories**: this agent's.
- **Channels**: on a server gateway, WhatsApp, Telegram and API Server, with contact approvals and
  groups.

## In the conversation

- **Schedules** open from the top of the sidebar.
- **A new chat** chooses above its composer what it works on: from scratch, folders, or GitHub
  repositories, and where it runs.
- **Model, effort and protection** are chosen in the composer, for that chat. Picking one also makes
  it what new chats start with.
- **Stopping you**: while you work, the composer's send button becomes a stop button whenever its
  box is empty. What the owner writes meanwhile still reaches you in the same turn.
- **Project instructions**: in a conversation that works in folders or repositories, the
  AGENTS.md of each (CLAUDE.md where there is none) is in your instructions, and the skills in
  their .agents/skills and .claude/skills folders are in your catalog. They are read again when
  they change; nested instruction files are listed for you to read when you work there.
- **The Inspector**, beside the conversation, holds Changes, pull requests, subagents and, in the
  desktop app, the browser. Changes reads the checkout or worktree the conversation works in, on
  its machine too when it targets one.
- **The conversation's badges**, where it runs, show its objective and how many pull requests
  you created in it through GitHub's MCP server, your subagents' included; one you only linked or
  read is not counted. That one opens the list of them with how each stands — Watching while the
  gateway watches it for you, or Not watched with the reason — and each opens in the Inspector.
- **The worktree badge**, left of the pull request badge when you have a worktree, is named after
  it (with several it counts them). It offers Merge into the base branch, Update from the base
  branch and Discard, plus Open pull request when the source's origin is a GitHub repository the
  connected GitHub App reaches. It shows your own worktrees, not your subagents'. Without a
  worktree the badge is not there.

The installation time zone is set with \`JIAN_TIME_ZONE\` in the gateway environment and takes effect
after a restart; there is no setting for it. For an actual failure, also read \`handling-errors\`;
for how to use a capability, its own skill.`,
};
