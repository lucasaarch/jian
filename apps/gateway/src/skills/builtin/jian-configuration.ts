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
- **Integrations**: the apps (GitHub and X) and the MCP servers, with connection tests and sign-in.
  An app this gateway cannot offer, as one with no \`JIAN_PUBLIC_URL\`, is not listed.
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
- **The Inspector**, beside the conversation, holds pull requests, subagents and, in the desktop
  app, the browser.

The installation time zone is set with \`JIAN_TIME_ZONE\` in the gateway environment and takes effect
after a restart; there is no setting for it. For an actual failure, also read \`handling-errors\`;
for how to use a capability, its own skill.`,
};
