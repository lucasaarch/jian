import type { Skill } from '@jian/contracts';

export const jianConfiguration: Skill = {
  name: 'jian-configuration',
  description:
    'Use when asked where to configure a Jian capability, model, provider, channel, agent, schedule, memory, skill or MCP server in the panel.',
  instructions: `# Where Jian is configured

The owner configures the installation in the panel. Name the shortest path to the setting;
do not imply you can change an owner-only setting yourself.

- Overview: activity, tokens and estimated cost. For your own full data, see activity.
- Agent: your name, picture, instructions, identity and capability switches for other agents,
  self-management, shell, web search and learning.
- Providers: model providers, the Tavily web-search key and Decisions (Jev).
- Model defaults: the installation's models for chats, channels, compaction, image and audio
  analysis, sticker analysis, image generation and speech, shared by every agent. Automatic selects from connected providers;
  Disabled turns off that activity where offered. Disabled sticker analysis stops recognizing
  new stickers, but existing stickers remain available to send.
- Channels: WhatsApp, Telegram, contact approvals and groups.
- Chats: conversation history and per-chat model and effort selection.
- Remote Control: connect computers, authorize agents, and install the per-user worker that
  starts again on login after a reboot.
- Schedules, Memories and Skills: each agent's own resources.
- Integrations (under Gateway): the GitHub App and the MCP servers, shared by every agent. MCPs
  also offers connection tests and sign-in.

The installation time zone is set with JIAN_TIME_ZONE in the gateway environment and takes
effect after a restart; there is no Settings page for it. For an actual failure, also read
handling-errors; for a capability's usage, read its dedicated skill.`,
};
