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

- **General, Appearance, Keymaps**: the app itself. General also holds Privacy: the gateway's
  anonymous daily report, on by default. Once a day it sends counts under a random id (version
  and system, how many agents and runs, which models, tools and apps were used, why runs failed),
  never a message, a name, an address, a file or a credential. The owner turns it off there; a
  host with \`DO_NOT_TRACK=1\` or \`JIAN_TELEMETRY=off\` has it off for good.
- **Providers**: model providers, the Tavily web-search key and Decisions (Jev).
- **Capabilities**: the models for channels, incoming audio, image generation and speech. A
  conversation is compacted by its own model. Automatic selects from connected providers;
  Disabled turns that activity off where offered.
- **Apps**: a card for each app, connected ones first, with a search and a category list.
  GitHub and X are Jian's own, with accounts to connect and configure; one this gateway cannot
  offer, as one with no \`JIAN_PUBLIC_URL\`, is not listed. The others, such as Linear, Notion,
  Atlassian, Stripe, Sentry, Vercel and Supabase, are each service's own MCP server: Connect saves
  it and opens its sign-in. Once connected, Configure lists its accounts, each an MCP server named
  after the account that signed in ("linear_octo"), or numbered ("linear_2") when the service
  cannot say who that is, with Sign in and Remove, and connects another. Its
  card is all there is of it: it is not listed under MCP servers, and its tools cannot be switched
  off.
- **MCP servers**: the MCP servers added by hand, with connection tests, sign-in and switching
  tools off. A server connected from Apps is not here.
- **SSH keys**: the keys every agent uses for Git.
- **Machines**: on a server gateway, the computers every agent can use, and how to install their
  worker. A desktop app connected to that gateway is listed as This computer.
- **Mobile**: on a server gateway, pairs a phone with the Jian app by QR code, lists the paired
  phones with when each was last seen, turns message previews in notifications on or off per
  phone, and revokes a phone. The gateway needs its public address set to pair one.
- **Connection**: on a server gateway, how this panel reaches it.

## Agent settings

One agent's own, from the agent chooser at the foot of the sidebar.

- **Activity**: tokens, runs and estimated cost. For your own full figures, see \`activity\`.
- **Identity**: name, picture, instructions, summary for the team and boundaries, and Compact
  conversations: whether its conversations are summarised near the model's limit, the default,
  or at a size the owner sets. See \`managing-context\`.
- **Skills** and **Memories**: this agent's.
- **Channels**: on a server gateway, WhatsApp, Telegram, Email and API Server, with contact
  approvals and groups. Email goes through Resend or Cloudflare, chosen when it is connected,
  with JIAN_PUBLIC_URL set so the provider can reach the gateway. Resend takes an API key with
  full access and an address on a domain verified there with receiving on and its MX record;
  Jian registers the webhook. Cloudflare takes an API token, the account ID and an address of
  a zone in that account, with Email Routing enabled and the domain onboarded in Email Sending
  in the dashboard; Jian uploads a Worker that forwards the address's mail and adds its routing
  rule. The token needs Account › Email Sending: Edit, Account › Workers Scripts: Edit, Zone ›
  Email Routing Rules: Edit, Zone › Zone Settings: Read and Zone › Zone: Read. Disconnecting
  removes the webhook, or the rule and the Worker. Its senders, actions and questions are
  approved in the panel, never by email.

## In the conversation

- **Schedules** open from the top of the sidebar.
- **Pull requests**, below Schedules on a server gateway with GitHub connected, list the open
  pull requests of every connected account in place of the chat. Review there hands one to an
  agent; Review settings choose the reviewing agent, its instructions, and whether new pull
  requests are reviewed on their own through the GitHub App's webhook.
- **Renaming**: right-click a conversation in the sidebar, or use the palette, to rename a chat
  or a person on WhatsApp or Telegram. A chat is named by you from its first message until the
  owner renames it; a group keeps the name its members gave it.
- **A new chat** chooses above its composer what it works on: from scratch, folders, or GitHub
  repositories, and where it runs.
- **Model, effort and protection** are chosen in the composer, for that chat. Picking one also makes
  it what new chats start with.
- **Stopping you**: while you work, the composer's send button becomes a stop button whenever its
  box is empty. What the owner writes meanwhile still reaches you in the same turn.
- **Back to the latest message**: scrolled up from the end, however little, the owner gets a
  round down-arrow button over the end of the conversation; a dot on it means something new
  arrived below.
- **Project instructions**: in a conversation that works in folders or repositories, the
  AGENTS.md of each (CLAUDE.md where there is none) is in your instructions, and the skills in
  their .agents/skills and .claude/skills folders are in your catalog. They are read again when
  they change; nested instruction files are listed for you to read when you work there.
- **The Inspector**, beside the conversation, holds Changes, Files, pull requests, subagents and,
  in the desktop app, the browser. Changes reads the checkout or worktree the conversation works
  in, on its machine too when it targets one. Files lists every file of the conversation's
  projects, or of its worktrees, with the changed ones marked; the owner filters them and opens
  one in the conversation's place, with find and, for Markdown, a rendered page or its code. It
  only reads: nothing there edits a file, and the files of a conversation on a machine are not
  shown yet.
- **The conversation's badges**, where it runs, show its objective and how many pull requests
  you created in it through GitHub's MCP server, your subagents' included; one you only linked or
  read is not counted. That one opens the list of them with how each stands — Watching while the
  gateway watches it for you, or Not watched with the reason — and each opens in the Inspector.
- **The subagents badge**, at the start of that row, shows while any of your subagents in this
  conversation is queued or running ("2 agents working"). It lists each one with what it is doing
  and for how long, and opens it in the Inspector; it goes away when the last one ends.
- **The worktree badge**, left of the pull request badge when you have a worktree, is named after
  it (with several it counts them). It offers Merge into the base branch, Update from the base
  branch and Discard, plus Open pull request when the source's origin is a GitHub repository the
  connected GitHub App reaches. It shows your own worktrees, not your subagents'. Without a
  worktree the badge is not there.

The installation time zone is set with \`JIAN_TIME_ZONE\` in the gateway environment and takes effect
after a restart; there is no setting for it. For an actual failure, also read \`handling-errors\`;
for how to use a capability, its own skill.`,
};
