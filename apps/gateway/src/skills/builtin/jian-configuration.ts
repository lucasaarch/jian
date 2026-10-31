import type { Skill } from '@jian/contracts';

export const jianConfiguration: Skill = {
  name: 'jian-configuration',
  description:
    'Use when asked where to configure a Jian capability, model, provider, channel, agent, schedule, memory, skill or MCP server in the panel.',
  instructions: `# Where Jian is configured

The owner configures the installation in the panel. Name the shortest path to the setting;
do not imply you can change an owner-only setting yourself.

- Overview: activity, tokens and estimated cost. For your own full data, see activity.
- Agent: your name, picture, instructions, summary for the team and boundaries. Talking with
  other agents, managing yourself, the shell, web search and learning are always on.
- Providers: model providers, the Tavily web-search key and Decisions (Jev).
- Capabilities: the installation's models for channels, compaction, audio, image generation and
  speech, shared by every agent. Automatic selects from connected providers; Disabled turns off
  that activity where offered. A chat's own model, which also reads its images and documents, is
  chosen in the chat; a new chat starts from what the last one started with.
- Channels: WhatsApp, Telegram, contact approvals and groups.
- Chats: conversation history and per-chat model and effort selection.
- Machines: connect computers, which every agent can use, and install the per-user worker that
  starts again on login after a reboot.
- Schedules, Memories and Skills: each agent's own resources.
- Integrations (under Gateway): the GitHub App and the MCP servers, shared by every agent. MCPs
  also offers connection tests and sign-in.

The installation time zone is set with JIAN_TIME_ZONE in the gateway environment and takes
effect after a restart; there is no Settings page for it. For an actual failure, also read
handling-errors; for a capability's usage, read its dedicated skill.`,
};
